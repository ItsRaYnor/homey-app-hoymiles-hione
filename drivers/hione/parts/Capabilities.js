'use strict';

/**
 * Bringing a device paired with an older version in line with the current
 * manifest: capabilities added, removed and put in their place on the card.
 *
 * Part of HiOneDevice. The methods of this class are copied onto the
 * device's prototype at the end of device.js, so `this` is the device itself
 * and they can call, and be called by, everything else on it. This is one
 * class written in several files to keep each readable - nothing here is a
 * separate object at runtime.
 */

// Capabilities added after v1.0.x — added to existing devices on init
// Percent sliders are stored as plain 0–100 (matching the API and the Insights
// graphs). They deliberately have no units "%" in the manifest, because Homey
// renders a units-"%" capability as a 0–1 fraction ×100 — which made the
// Insights graph read 100× too small. The "%" is shown in the title instead.
const PERCENT_SLIDERS = [
  'hoymiles_max_soc_local',
  'hoymiles_reserve_soc_selfuse',
  'hoymiles_reserve_soc_forcecharge',
  'hoymiles_reserve_soc_forcedischarge',
  'hoymiles_max_charge_power',
  'hoymiles_max_discharge_power',
];

// Values kept for Insights, so the trading can be checked afterwards: the mode
// as a number (an enum is not logged), the plan's buy and sell moments as
// on/off, and the discharge floor the plan judged against. Only the floor gets
// a tile; the other three already show on the mode and price plan tiles.
// They go last in the tile order, so adding them does not reshuffle (and
// briefly remove) the energy meters Homey Energy reads.
const LOG_CAPABILITIES = [
  'hoymiles_battery_mode_number',
  'hoymiles_price_buy_moment',
  'hoymiles_price_sell_moment',
  'hoymiles_price_discharge_floor',
];

// The cheapest quarter still to come and when it starts (1.1.12). Also last
// in the order, for the same reason as the log capabilities above.
const PRICE_AHEAD_CAPABILITIES = [
  'hoymiles_price_low_ahead',
  'hoymiles_price_low_ahead_time',
  // What the charge on board cost (1.1.12).
  'hoymiles_price_charge_cost',
];

const NEW_CAPABILITIES = [
  'hoymiles_smartport_power',
  'hoymiles_battery_flow',
  'measure_voltage',
  'measure_current',
  'meter_power.charged',
  'meter_power.discharged',
  'hoymiles_reserve_soc_selfuse',
  'hoymiles_reserve_soc_forcecharge',
  'hoymiles_reserve_soc_forcedischarge',
  'hoymiles_max_charge_power',
  'hoymiles_max_discharge_power',
  'hoymiles_meter_power',
  'hoymiles_monthly_energy',
  'hoymiles_yearly_energy',
  'hoymiles_co2_reduction',
  'hoymiles_profit_today',
  'hoymiles_profit_total',
  'hoymiles_connection_source',
  'hoymiles_battery_mode_value',
  'hoymiles_max_soc_local',
  'hoymiles_max_soc_local_value',
  'hoymiles_min_soc_local_value',
  'hoymiles_price_plan',
  'hoymiles_price_now',
  'hoymiles_price_market_now',
  'hoymiles_price_charge_target',
  'hoymiles_price_low_today',
  'hoymiles_price_high_today',
  'hoymiles_reserve_soc_selfuse_value',
  'hoymiles_reserve_soc_forcecharge_value',
  'hoymiles_reserve_soc_forcedischarge_value',
  'hoymiles_max_charge_power_value',
  'hoymiles_max_discharge_power_value',
  'hoymiles_cell_spread',
  'hoymiles_cell_temp_max',
  ...LOG_CAPABILITIES,
  ...PRICE_AHEAD_CAPABILITIES,
];

// Tiles that only the stick can fill. A device set to "cloud only" does not get
// them: it may belong to another installation, and a tile that can never show a
// value is noise. Switching the device back to local adds them again.
const LOCAL_ONLY_CAPABILITIES = [
  'hoymiles_max_soc_local',
  'hoymiles_max_soc_local_value',
  'hoymiles_min_soc_local_value',
  'hoymiles_cell_spread',
  'hoymiles_cell_temp_max',
];

// Capabilities replaced by a better equivalent — removed from existing devices.
// The device is now a Homey "home battery": measure_power = battery power and
// charged/discharged energy is tracked via meter_power.charged/.discharged.
// The order the tiles appear in on the device card. Homey renders a device in
// the order the DEVICE stores its capabilities, not the order in this manifest:
// a manifest change reaches newly paired devices only, and addCapability always
// appends. So an existing device is brought in line by re-adding everything from
// the first difference onwards — see _migrateCapabilityOrder.
//
// Rule of the layout: what you look at or act on in the moment goes up top —
// battery power and current, the mode, the SOC window, the power limits — and
// what only matters as a trend over months (cell spread, cell temperature) goes
// to the bottom.
const CAPABILITY_ORDER = [
  // Live, off the stick, every poll. Battery power and current sit together at
  // the top; only measure_power keeps its original place, because Homey Energy
  // reads it for the home battery and it is not worth removing even briefly.
  'measure_power',
  'hoymiles_battery_flow',
  'measure_battery',
  'measure_current',
  'measure_voltage',
  // What you operate: the mode, then the SOC window it works within, then the
  // power limits. Each read-only tile sits next to the slider that sets it, so
  // the tile grid and the control list come out in the same order.
  'hoymiles_battery_mode_value',
  'hoymiles_battery_mode',
  'hoymiles_reserve_soc_selfuse_value',
  'hoymiles_reserve_soc_selfuse',
  'hoymiles_reserve_soc_forcecharge_value',
  'hoymiles_reserve_soc_forcecharge',
  'hoymiles_reserve_soc_forcedischarge_value',
  'hoymiles_reserve_soc_forcedischarge',
  'hoymiles_max_soc_local_value',
  'hoymiles_max_soc_local',
  'hoymiles_min_soc_local_value',
  'hoymiles_max_charge_power_value',
  'hoymiles_max_charge_power',
  'hoymiles_max_discharge_power_value',
  'hoymiles_max_discharge_power',
  // What the market says to do, right under the controls it applies to.
  'hoymiles_price_plan',
  'hoymiles_price_now',
  'hoymiles_price_market_now',
  'hoymiles_price_charge_target',
  'hoymiles_price_low_today',
  'hoymiles_price_high_today',
  // The rest of the installation, also read locally.
  'hoymiles_grid_power',
  'hoymiles_load_power',
  'hoymiles_smartport_power',
  'hoymiles_meter_power',
  // Everything below here comes from the cloud and lags by minutes — the ☁
  // tiles — so it sits out of the way of the values you act on.
  'meter_power.charged',
  'meter_power.discharged',
  'hoymiles_daily_energy',
  'hoymiles_monthly_energy',
  'hoymiles_yearly_energy',
  'hoymiles_total_energy',
  'hoymiles_co2_reduction',
  'hoymiles_profit_today',
  'hoymiles_profit_total',
  // Diagnostics last: months-long trends, nothing you act on in the moment.
  'hoymiles_cell_spread',
  'hoymiles_cell_temp_max',
  'hoymiles_connection_source',
  ...LOG_CAPABILITIES,
  ...PRICE_AHEAD_CAPABILITIES,
];

const REMOVED_CAPABILITIES = [
  // Renamed to hoymiles_smartport_power. The register is the SMART PORT total
  // (three phase registers summed), so on a site with a battery on that port
  // the old name promised solar and delivered solar plus battery.
  'hoymiles_pv_power',
  'hoymiles_battery_power',
  'measure_power.battery',
  'hoymiles_max_power',           // → split into max_charge_power / max_discharge_power
  'meter_power',                  // base PV total — not used for a battery device
  'hoymiles_battery_in_energy',   // → meter_power.charged
  'hoymiles_battery_out_energy',  // → meter_power.discharged
  // A single reserve tile could not say WHICH mode's reserve it was showing:
  // the value lives in a different register per mode, so it alternated between
  // two modes' numbers as the app's idea of the active mode moved. Split into
  // one tile per mode, each bound to its own register.
  'hoymiles_reserve_soc',
  'hoymiles_reserve_soc_value',
  // Replaced by hoymiles_max_soc_local, which binds in every battery mode and is
  // written straight to the stick. The old one was the cloud's per-mode field:
  // it does not exist in Self-Consumption or Force Charge at all, so the tile sat
  // blank most of the time and the slider refused. Its definition stays in the
  // manifest until every device has migrated past it.
  'hoymiles_max_soc',
];

class Capabilities {

  async _migrateCapabilities(settingsOverride) {
    const cloudOnly = this._isCloudOnly(settingsOverride);
    const dropped = cloudOnly ? LOCAL_ONLY_CAPABILITIES : [];

    // Remove obsolete capabilities FIRST: a leftover capability that is no
    // longer defined in the manifest leaves the device in an invalid state and
    // makes subsequent addCapability calls fail.
    for (const capability of [...REMOVED_CAPABILITIES, ...dropped]) {
      if (this.hasCapability(capability)) {
        try {
          await this.removeCapability(capability);
          this.log('Removed capability ' + capability);
        } catch (err) {
          this.error('Could not remove capability ' + capability + ': ' + err.message);
        }
      }
    }
    for (const capability of NEW_CAPABILITIES) {
      if (dropped.includes(capability)) continue;
      if (!this.hasCapability(capability)) {
        try {
          await this.addCapability(capability);
          this.log('Added capability ' + capability);
        } catch (err) {
          this.error('Could not add capability ' + capability + ': ' + err.message);
        }
      }
    }

    await this._migrateCapabilityOrder();

    // Force the new 0–100 slider options on existing devices, and clear the
    // cached units "%" — Homey rendered a units-"%" capability as a 0–1 fraction
    // ×100, which made the Insights graph read 100× too small. Now stored as a
    // plain 0–100 percent (the "%" lives in the title).
    for (const capability of PERCENT_SLIDERS) {
      if (this.hasCapability(capability)) {
        try {
          // Step 5, not 1. Every value this app's automation writes is a
          // multiple of five — ceiling 5/100, reserve 30/100, discharge 15/30,
          // charge power 0/20 — so the slider snaps onto exactly the settings
          // that are actually used, instead of demanding millimetre work on a
          // phone. The paired read-only tile still shows the true value, so a
          // number set elsewhere (S-Miles) is never hidden by the snapping.
          await this.setCapabilityOptions(capability, {
            min: 0, max: 100, step: 5, decimals: 0, units: '',
          });
        } catch (err) {
          this.error('Could not update options for ' + capability + ': ' + err.message);
        }
      }
    }
  }

  /**
   * Put the device card's tiles in CAPABILITY_ORDER.
   *
   * There is no reorder API: removeCapability + addCapability is the only lever,
   * and adding always appends. Walking the target order and doing remove-then-add
   * per capability therefore lands each one at the end in sequence, which builds
   * exactly the wanted order — and leaves at most ONE capability missing at any
   * moment, so a crash halfway cannot strip the device.
   *
   * Only the tail from the first difference is touched. Everything before it is
   * already right, which is what keeps measure_power and the two energy meters —
   * the ones Homey Energy reads for a home battery — from being removed at all.
   *
   * Insights history survives: a log is keyed by device + capability id, and the
   * logs of capabilities retired in earlier versions are still there. Values are
   * blank for the moment between remove and add; the poll at the end of onInit
   * fills them straight back in.
   */
  async _migrateCapabilityOrder() {
    const current = this.getCapabilities();
    const desired = CAPABILITY_ORDER.filter((cap) => current.includes(cap));

    // Refuse on anything unexpected rather than reshuffling a device whose set
    // this list does not describe — a capability missing here would be dropped.
    const unknown = current.filter((cap) => !CAPABILITY_ORDER.includes(cap));
    if (unknown.length) {
      this.log('Skipping tile reorder, unknown capabilities: ' + unknown.join(', '));
      return;
    }

    let i = 0;
    while (i < desired.length && current[i] === desired[i]) i++;
    if (i >= desired.length) return; // already in order

    this.log('Reordering ' + (desired.length - i) + ' tiles on the device card');
    for (const capability of desired.slice(i)) {
      try {
        await this.removeCapability(capability);
        await this.addCapability(capability);
      } catch (err) {
        this.error('Could not reorder ' + capability + ': ' + err.message);
        // Try to put it back rather than leave the device without it.
        if (!this.hasCapability(capability)) {
          await this.addCapability(capability).catch(() => {});
        }
        return;
      }
    }
  }

}

module.exports = Capabilities;
