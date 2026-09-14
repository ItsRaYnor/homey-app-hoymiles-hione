'use strict';

const { Device } = require('homey');
const HoymilesHybrid = require('../../lib/HoymilesHybrid');
const { BATTERY_MODES } = require('../../lib/HoymilesApi');
const FrankPrices = require('../../lib/FrankPrices');
const { discoverGateways, subnetBaseFromAddress } = require('../../lib/NetworkScan');

// Battery mode / reserve / max-power use a slow async cloud command (a job
// read that can take ~30s), so they refresh on their own slower cadence —
// independent of the live poll interval (~60s). An in-app change still
// refreshes immediately (see the battery-mode capability listener).
// Heavy cloud settings (mode / reserve / max-power / EPS) — keep light live
// data on the normal poll interval (~60s) and refresh this slower.
const SETTINGS_REFRESH_MS = 5 * 60_000; // 5 min

// How often to confirm the stick is still at the address we are using, and
// the floor between two subnet sweeps. The check costs one Modbus read when
// the stick is there and one timeout when it is not, so it can be frequent;
// the sweep touches 254 hosts, so it may not be.
const GATEWAY_WATCH_MS      = 15 * 60_000;
const GATEWAY_RESCAN_MIN_MS = 30 * 60_000;

// The day plan only changes when the clock moves into the next price hour, and
// the prices themselves are fetched once a day. Recomputing every minute would
// be free but pointless; once a minute past the poll is close enough to catch
// the hour change without a burst of capability writes.
const PRICE_REFRESH_MS = 60_000; // 1 min

// How far the Self-Consumption reserve may sit below the charge before holding
// the battery rewrites it. Slack, so a drifting SOC reading does not spend an
// EEPROM write every few minutes; small enough that little can leak out first.
const HOLD_TOLERANCE_PCT = 3;

// Same idea for the charge target: a percent either way is not worth a write.
const TARGET_TOLERANCE_PCT = 2;

// Other batteries on the same meter are invisible to this app: a Homey app only
// sees its own devices. So a Flow tells it, once a minute, and the report keeps
// for a little longer than that. Expiring rather than latching is deliberate —
// if the reporting Flow is disabled or Homey restarts, the guards open again
// instead of silently holding this battery back forever.
const OTHER_BATTERY_TTL_MS = 3 * 60_000;

// Selecting the battery mode in the app fires for every value scrolled past.
// Wait until the choice settles before writing it, so scrolling through the
// picker does not apply each intermediate mode.
//
// This matters MORE now that the write goes over Modbus. A cloud switch took
// about four minutes and an intermediate mode was superseded long before it
// landed; a local write takes seconds and actually happens. Scrolling past
// Off-Grid with a pause would really put the inverter off-grid. The delay is
// not the bottleneck either — the inverter itself needs roughly six seconds to
// act — so shortening it buys nothing and costs safety.
const MODE_APPLY_DELAY_MS = 3_000;

// The cloud rejects a new mode write until the previous one has settled
// (~10s), so enforce a minimum gap between mode writes to avoid API errors.
const MODE_MIN_INTERVAL_MS = 10_000;

// Homey fails a capability listener with "Timeout after 10000ms" if it has not
// resolved in ten seconds. Our cloud calls carry a fifteen-second HTTP timeout
// and setMaxSoc makes two of them back to back, so simply awaiting the write
// cannot meet that budget — the user gets a timeout even when the write goes on
// to succeed. Reported live on 2026-09-06, moving the max charge level slider.
const SETTING_LISTENER_BUDGET_MS = 8_000;

// The local power limit is persisted to the inverter's EEPROM on every write.
// Cap automated writes per day and skip no-op writes to limit chip wear.
const POWER_LIMIT_MAX_WRITES_PER_DAY = 10;

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

// Values that always come from the cloud, even when the live data is read
// locally over Modbus — so they lag by minutes. Their titles get a small cloud
// marker appended while a local connection is active, making it obvious per
// tile which readings are instant and which are not. Everything else (battery
// power/SoC/voltage/current, grid, PV, house load) comes straight off the stick.
const CLOUD_SOURCED_CAPABILITIES = [
  // The battery mode is NOT here any more: since v1.1.2 it is read straight off
  // the stick on every poll, so marking it as cloud-sourced would be a lie.
  'meter_power.charged',
  'meter_power.discharged',
  'hoymiles_daily_energy',
  'hoymiles_monthly_energy',
  'hoymiles_yearly_energy',
  'hoymiles_total_energy',
  'hoymiles_co2_reduction',
  'hoymiles_profit_today',
  'hoymiles_profit_total',
  'hoymiles_reserve_soc_selfuse',
  'hoymiles_reserve_soc_forcecharge',
  'hoymiles_reserve_soc_forcedischarge',
  'hoymiles_max_charge_power',
  'hoymiles_max_discharge_power',
  'hoymiles_meter_power',
];
const CLOUD_MARKER = ' ☁';

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
];

// Per-module BMS detail is local-only and slow-moving, so it gets its own slow
// cadence rather than riding the 60s live poll. Reading four modules takes
// about eight seconds; a quarter of an hour is plenty for a metric whose whole
// point is a trend over months.
const BMS_REFRESH_MS = 15 * 60_000;

// The reserve SOC is stored per battery mode, in its own register each. Showing
// them as one tile meant the tile silently changed meaning with the mode — a
// discharge floor in Self-Consumption, a charge target in Force Charge — and
// flipped between the two values whenever the app's idea of the active mode was
// a step behind. One tile per mode, keyed by mode number.
// Short labels for the mode tile. The full names ("Force Discharge") already fill
// the tile on their own, and with the power beside them they get cut off — which
// is worse than an abbreviation, because a truncated label hides which mode it is.
const SHORT_MODE_NAMES = {
  1: 'Self-use', 2: 'Eco', 3: 'Backup', 4: 'Off-Grid', 5: 'F-Charge',
  6: 'F-Disch', 7: 'Peak', 8: 'ToU', 9: 'AI',
};

const RESERVE_SOC_SLIDERS = {
  1: 'hoymiles_reserve_soc_selfuse',
  5: 'hoymiles_reserve_soc_forcecharge',
  6: 'hoymiles_reserve_soc_forcedischarge',
};
const RESERVE_SOC_LABELS = {
  1: 'Self-Consumption',
  5: 'Force Charge',
  6: 'Force Discharge',
};
const RESERVE_SOC_LABEL_KEYS = {
  1: 'labels.reserve_selfuse',
  5: 'labels.reserve_forcecharge',
  6: 'labels.reserve_forcedischarge',
};

// The three settings that can be read straight off the stick. The sliders stay
// the place to change them; these read-only twins put the current value in the
// device card's tile grid next to the live measurements.
const SETTING_VALUE_CAPABILITY = {
  hoymiles_max_soc_local:           'hoymiles_max_soc_local_value',
  hoymiles_reserve_soc_selfuse:     'hoymiles_reserve_soc_selfuse_value',
  hoymiles_reserve_soc_forcecharge: 'hoymiles_reserve_soc_forcecharge_value',
  hoymiles_reserve_soc_forcedischarge: 'hoymiles_reserve_soc_forcedischarge_value',
  hoymiles_max_charge_power:    'hoymiles_max_charge_power_value',
  hoymiles_max_discharge_power: 'hoymiles_max_discharge_power_value',
};

// getBatterySettings() reports which fields it managed to read locally; map
// those back to capabilities so the cloud marker only labels what is really
// lagging. The per-mode reserves are not in here: they are read from named
// registers on every poll and so are never cloud-sourced.
const LOCAL_SETTING_CAPABILITY = {
  maxChargePower:    'hoymiles_max_charge_power',
  maxDischargePower: 'hoymiles_max_discharge_power',
};

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

class HiOneDevice extends Device {

  async onInit() {
    this.log('HiOne device initialising...');
    this._prevBatteryMode = null;
    this._lastSettingsRefresh = 0;
    this._followupTimers = [];
    this._modeChangeTimer = null;
    this._lastModeApplyAt = 0;
    this._pollInFlight = false;
    this._settingsRefreshInFlight = null;
    this._lastPriceRefresh = 0;
    this._otherBatteryReports = { charging: 0, discharging: 0 };
    this._pricePlan = null;
    this._prices = new FrankPrices({
      log: (...args) => this.log(...args),
      error: (...args) => this.error(...args),
    });

    this._gatewayOverride = null;
    this._gatewayHost = null;
    this._gatewayScanAt = 0;
    this._gatewayCheckInFlight = null;

    await this._migrateCapabilities();
    this._createHybrid();
    this._ensureGatewayReachable()
      .catch(() => {})
      .finally(() => this._fetchGatewayInfo());
    this._startGatewayWatch();

    this.registerCapabilityListener('hoymiles_battery_mode', async (value) => {
      // Debounce: the picker fires for every mode scrolled past. Only apply the
      // value the user settles on. Also enforce a ~10s gap between writes — the
      // cloud rejects a new mode while the previous one is still settling — so a
      // quick second choice waits out the cooldown instead of erroring.
      this._pendingMode = value;
      if (this._modeChangeTimer) this.homey.clearTimeout(this._modeChangeTimer);
      const cooldown = this._hybrid && this._hybrid.isModbusActive() ? 0 : MODE_MIN_INTERVAL_MS;
      const cooldownLeft = this._lastModeApplyAt + cooldown - Date.now();
      const delay = Math.max(MODE_APPLY_DELAY_MS, cooldownLeft);
      this._modeChangeTimer = this.homey.setTimeout(() => {
        this._modeChangeTimer = null;
        this._applyBatteryMode(this._pendingMode)
          .catch(err => this.error('Mode change failed: ' + err.message));
      }, delay);
    });

    // NOTE: slider listeners deliberately do NOT call _refreshBatterySettings()
    // afterwards. The cloud write is async and re-reading immediately returns
    // the stale (pre-write) value, which setCapabilityValue then writes back to
    // the slider — resetting it to 0 while the user is still dragging. The
    // periodic poll reconciles the slider with the cloud a bit later instead.
    // One slider per mode, each writing its own register. The mode is part of
    // the slider's identity rather than something looked up at write time, so
    // there is nothing left to get stale: setting the Force Charge reserve while
    // the station runs Self-Consumption is now an ordinary thing to do, not a
    // mistake waiting to happen.
    for (const [mode, slider] of Object.entries(RESERVE_SOC_SLIDERS)) {
      this.registerCapabilityListener(slider,
        this._settingListener(RESERVE_SOC_LABELS[mode] + ' reserve', async (value) => {
          await this._hybrid.setReserveSocForMode(Number(mode), value);
          await this._setCapabilitySafe(SETTING_VALUE_CAPABILITY[slider], value);
        }, RESERVE_SOC_LABEL_KEYS[mode]));
    }

    this.registerCapabilityListener('hoymiles_max_charge_power',
      this._settingListener('Max charge power', async (value) => {
        await this._hybrid.setMaxChargePower(value);
        await this._setCapabilitySafe(SETTING_VALUE_CAPABILITY.hoymiles_max_charge_power, value);
      }, 'labels.max_charge_power'));

    this.registerCapabilityListener('hoymiles_max_discharge_power',
      this._settingListener('Max discharge power', async (value) => {
        await this._hybrid.setMaxDischargePower(value);
        await this._setCapabilitySafe(SETTING_VALUE_CAPABILITY.hoymiles_max_discharge_power, value);
      }, 'labels.max_discharge_power'));

    this.registerCapabilityListener('hoymiles_max_soc_local',
      this._settingListener('Local charge ceiling', async (value) => {
        await this._hybrid.setMaxSocLocal(value);
        await this._setCapabilitySafe(SETTING_VALUE_CAPABILITY.hoymiles_max_soc_local, value);
      }, 'labels.charge_ceiling'));

    this.registerCapabilityListener('hoymiles_meter_power',
      this._settingListener('Grid limit', (value) => this._hybrid.setGridLimit(value),
        'labels.grid_limit'));

    this._startPolling();
    await this._poll();
    this.log('HiOne device ready');
  }

  async onDeleted() {
    this._stopPolling();
    this._clearFollowupPolls();
    if (this._gatewayWatch) this.homey.clearInterval(this._gatewayWatch);
    if (this._modeChangeTimer) this.homey.clearTimeout(this._modeChangeTimer);
    if (this._pausePollingTimer) this.homey.clearTimeout(this._pausePollingTimer);
    this.log('HiOne device removed');
  }

  /**
   * Mark cloud-sourced values with a small ☁ in their title while part of the
   * data is read locally, so it is visible per tile which readings are live and
   * which lag behind. Removed again when everything comes from the cloud (then
   * the distinction is meaningless). Only runs when the source actually changes.
   */
  async _applyCloudMarkers(source) {
    const mixed = source === 'modbus_cloud' || source === 'modbus' || source === 'native';

    // Settings we managed to read locally this cycle are not lagging, so they
    // must not carry the marker. Reserve SOC moves in and out of that set as
    // the battery mode changes, hence recomputing instead of a fixed list.
    const local = this._localSettingCaps || new Set();
    const lagging = CLOUD_SOURCED_CAPABILITIES.filter(c => !local.has(c));

    // Cheap guard against redoing identical work on every poll.
    const signature = `${mixed}|${lagging.join(',')}`;
    if (this._cloudMarkerSignature === signature) return;
    this._cloudMarkerSignature = signature;

    const lang = this.homey.i18n.getLanguage();
    const pick = (title) => (title && (title[lang] || title.en)) || null;
    const driverOpts = (this.driver.manifest && this.driver.manifest.capabilitiesOptions) || {};
    const appCaps    = (this.homey.manifest && this.homey.manifest.capabilities) || {};

    // Strip the marker from anything that is no longer cloud-sourced at all.
    // Walking only the list below would leave a stale marker behind forever on a
    // capability that was removed from it — which is exactly what happened to the
    // battery mode when it became a local read.
    for (const capability of this.getCapabilities()) {
      if (CLOUD_SOURCED_CAPABILITIES.includes(capability)) continue;
      try {
        const opts = this.getCapabilityOptions(capability) || {};
        if (typeof opts.title === 'string' && opts.title.includes(CLOUD_MARKER)) {
          await this.setCapabilityOptions(capability,
            { ...opts, title: opts.title.replace(CLOUD_MARKER, '') });
        }
      } catch (_) { /* no options set for this one */ }
    }

    // Walk the full list, not just the marked ones: a capability that just
    // became locally readable has to get its marker taken off again.
    for (const capability of CLOUD_SOURCED_CAPABILITIES) {
      if (!this.hasCapability(capability)) continue;
      const marked = mixed && !local.has(capability);
      try {
        // Keep whatever options are already set (slider ranges, enum values);
        // only the title changes.
        let options = {};
        try { options = this.getCapabilityOptions(capability) || {}; } catch (_) { /* none set yet */ }

        const base = pick(driverOpts[capability] && driverOpts[capability].title)
          || pick(appCaps[capability.split('.')[0]] && appCaps[capability.split('.')[0]].title)
          || (options.title || '').replace(CLOUD_MARKER, '');
        if (!base) continue;

        const title = marked ? base + CLOUD_MARKER : base;
        if (options.title === title) continue;
        await this.setCapabilityOptions(capability, { ...options, title });
      } catch (err) {
        this.log(`Could not label ${capability}: ${err.message}`);
      }
    }
  }

  /**
   * Refresh the per-module cell data, at most every BMS_REFRESH_MS.
   *
   * Only two numbers reach the device card: the cell spread and the highest
   * cell temperature. Those are the ones worth a graph — a spread creeping up
   * over months is the earliest sign of a weakening cell. The 32 individual
   * cell readings would be unreadable as tiles; they are available on demand
   * from the app settings instead.
   */
  async _refreshBmsData() {
    if (this._bmsRefreshAt && Date.now() - this._bmsRefreshAt < BMS_REFRESH_MS) return;
    this._bmsRefreshAt = Date.now();

    // Reuse the address found last time so a restart does not pay for
    // rediscovery; the hybrid verifies it before trusting it.
    const hint = this.getStoreValue('bms_base');
    const bms = await this._hybrid.getBmsData(typeof hint === 'number' ? hint : undefined);
    if (!bms) return;

    if (bms.base !== hint) {
      await this.setStoreValue('bms_base', bms.base).catch(() => {});
    }
    await this._setCapabilitySafe('hoymiles_cell_spread',   bms.spreadMv);
    await this._setCapabilitySafe('hoymiles_cell_temp_max', bms.tempMaxC);
  }

  /**
   * Refresh the three settings that live in the stick, on the normal live poll.
   *
   * Without this they would only move on the five-minute cloud settings
   * refresh, so a change made in S-Miles (or the sliders' own tiles after a
   * write) could sit stale for minutes even though the register next to it was
   * already current. Three register reads, so cheap enough to run every time.
   */
  /**
   * Wrap a slider's write so it fits inside Homey's ten-second listener budget.
   *
   * Finishing in time is the normal case and behaves normally — including
   * rejecting, which is the only way a genuine refusal reaches the user. The
   * old code caught every error and logged it, so a refusal like "Force Charge
   * has no max charge level" was invisible: no message, and the slider kept
   * showing a number that had never been written.
   *
   * Running long, we let go of the request instead of holding the UI hostage
   * until it fails with a timeout that says nothing about what went wrong. The
   * tile is accepted, the write continues, and if it ultimately fails we put
   * the tile back to what the station actually reports and say why — by then
   * there is no request left to reject.
   */
  _settingListener(what, write, labelKey) {
    return async (value) => {
      const settled = write(value).then(
        () => ({ ok: true }),
        (err) => ({ ok: false, err })
      );
      const overBudget = new Promise((resolve) => {
        this.homey.setTimeout(() => resolve(null), SETTING_LISTENER_BUDGET_MS);
      });

      const result = await Promise.race([settled, overBudget]);
      if (result) {
        if (result.ok) return;
        this.error(what + ' change failed: ' + result.err.message);
        throw result.err;
      }

      this.log(what + ' is still being written after '
        + SETTING_LISTENER_BUDGET_MS + ' ms; releasing the slider so Homey does '
        + 'not report a timeout, and reporting the outcome separately.');
      settled.then((late) => {
        if (late.ok) return;
        this.error(what + ' change failed after the listener returned: ' + late.err.message);
        return this._reportLateFailure(labelKey || what, late.err, Boolean(labelKey));
      }).catch(() => {});
    };
  }

  // A write that failed after we already told Homey the slider was accepted.
  // Reconcile the tile with the station first, so it stops showing a value that
  // was never applied, then tell the user why — silently reverting a slider
  // under someone's finger is its own kind of bug.
  async _reportLateFailure(what, err, translate) {
    await this._refreshBatterySettings().catch(() => {});
    try {
      if (this.homey.notifications) {
        const name = translate ? String(this.homey.__(what)) : what;
        // Homey's __() does not substitute tokens, so do it here.
        const excerpt = String(this.homey.__('errors.set_failed'))
          .replace('{{what}}', name)
          .replace('{{reason}}', err.message);
        await this.homey.notifications.createNotification({ excerpt });
      }
    } catch (notifyErr) {
      this.error('Could not raise a notification: ' + notifyErr.message);
    }
  }

  async _refreshLocalSettings() {
    // Before anything else, and before the early return below: the mode is the
    // one value where being a poll late actually changes behaviour, because the
    // reserve SOC register is chosen by it.
    const localMode = await this._hybrid.getBatteryMode();
    if (localMode !== null && localMode !== undefined) {
      await this._updateBatteryMode(String(localMode), 'lokaal');
    } else {
      // No trustworthy local read: hand the mode back to the cloud rather than
      // let a stale 'lokaal' label keep the cloud value out.
      this._modeSource = null;
    }

    const local = await this._hybrid.getLocalSettings();
    if (!local) return;

    const fields = {
      maxChargePower:    'hoymiles_max_charge_power',
      maxDischargePower: 'hoymiles_max_discharge_power',
    };
    const read = [];
    for (const [field, slider] of Object.entries(fields)) {
      if (typeof local[field] !== 'number') continue;
      // Do not refill a setting the active mode does not have — the settings
      // refresh blanked it on purpose.
      if (this._modeSupports && this._modeSupports[field] === false) continue;
      read.push(slider);
      await this._setCapabilitySafe(slider, local[field]);
      await this._setCapabilitySafe(SETTING_VALUE_CAPABILITY[slider], local[field]);
    }
    // The battery mode, read straight off the stick on every poll. The cloud
    // only reports it with the five-minute settings refresh, and a stale mode is
    // not merely late: it decides which register a per-mode write lands in, so
    // being wrong changes what that write MEANS. Reading it locally removes the
    // guess entirely, and picks up a mode change within the poll interval
    // instead of up to five minutes later.
    // The device-wide charge ceiling. Worth showing on every poll: a ceiling
    // left below the current SOC silently blocks all charging, and without a
    // tile there is nothing to explain why the battery stopped taking power.
    const limits = await this._hybrid.getDeviceLimits();
    if (limits && typeof limits.maxSoc === 'number') {
      read.push('hoymiles_max_soc_local');
      await this._setCapabilitySafe('hoymiles_max_soc_local', limits.maxSoc);
      await this._setCapabilitySafe(SETTING_VALUE_CAPABILITY.hoymiles_max_soc_local, limits.maxSoc);
    }

    // The other end of that window, and it comes free in the same block read.
    // Shown but not settable: it is the floor that binds in every mode, so it
    // decides how deep the battery may really go when a per-mode reserve is set
    // lower — worth seeing. Writing it has not been tested on this hardware,
    // which is why there is a tile and no slider.
    if (limits && typeof limits.minSoc === 'number') {
      await this._setCapabilitySafe('hoymiles_min_soc_local_value', limits.minSoc);
    }

    // All three reserves, read from their own registers in one block request,
    // so no tile depends on knowing which mode is active.
    const reserves = await this._hybrid.getReserveSocByMode();
    if (reserves) {
      for (const [mode, slider] of Object.entries(RESERVE_SOC_SLIDERS)) {
        const value = reserves[mode];
        if (typeof value !== 'number') continue;
        read.push(slider);
        await this._setCapabilitySafe(slider, value);
        await this._setCapabilitySafe(SETTING_VALUE_CAPABILITY[slider], value);
      }
    }

    // Keeps the cloud marker honest between the heavier settings refreshes.
    if (read.length) this._localSettingCaps = new Set(read);
  }

  _clearFollowupPolls() {
    for (const t of this._followupTimers) this.homey.clearTimeout(t);
    this._followupTimers = [];
  }

  // Actually apply the chosen battery mode (after the debounce settles): write
  // it, re-read the settings, and re-poll the live data shortly after.
  async _applyBatteryMode(value) {
    this._lastModeApplyAt = Date.now();
    try {
      await this._hybrid.setBatteryMode(value);
    } catch (err) {
      this.error('Mode change rejected: ' + err.message);
      // Reconcile the tile with the mode that is really active, so it does not
      // keep showing a value that was never applied.
      this._refreshLocalSettings().catch(() => {});
      this._refreshBatterySettings().catch(() => {});
      return;
    }

    // Confirm from the stick, NOT from the cloud. The cloud still reports the
    // previous mode for minutes after a local write, and reading it here wrote
    // that stale value straight back into the picker — which is why a switch
    // that had already taken effect appeared to fall back to the old mode.
    await this._refreshLocalSettings().catch(() => {});
    this._refreshBatterySettings().catch(() => {});
    this._scheduleLivePollBurst();
  }

  // After a control change (mode / power), the cloud needs a few seconds to
  // report the new charge/discharge behaviour. Re-read the live data a couple
  // of times so it shows up without waiting for the next regular poll.
  _scheduleLivePollBurst() {
    this._clearFollowupPolls();
    for (const delay of [10_000, 20_000]) {
      this._followupTimers.push(this.homey.setTimeout(() => this._poll().catch(() => {}), delay));
    }
  }

  /**
   * Keep talking to the stick after DHCP moves it.
   *
   * A lease renewal can hand the stick a new address at any time, and the app
   * then talks to a host that is not there: every local read spends a timeout,
   * the battery mode falls back to the cloud and the power tiles freeze on
   * their last good reading with nothing to say so. Worse, the device settings
   * page - the one place to correct the address - is served by the same busy
   * app, so the correction is exactly what stops working.
   *
   * So the stick gets found instead of asked for. Order: the address in use,
   * then every other address we know of, then a sweep of the local /24. What
   * answers is remembered in the device STORE, which code can write; the
   * setting is left alone, because writing it needs the page that is stuck.
   */
  async _ensureGatewayReachable({ allowScan = true } = {}) {
    if (this._gatewayCheckInFlight) return this._gatewayCheckInFlight;
    this._gatewayCheckInFlight = this._runGatewayCheck({ allowScan })
      .finally(() => { this._gatewayCheckInFlight = null; });
    return this._gatewayCheckInFlight;
  }

  async _runGatewayCheck({ allowScan }) {
    // A cloud-only install has no stick to find; never sweep on its behalf.
    const known = this._gatewayHost
      || this.getSetting('gateway_ip')
      || this.getStoreValue('gatewayIp')
      || this.homey.settings.get('saved_gateway_ip');
    if (!known) return null;

    if (await this._hybrid.probeLocal().catch(() => false)) {
      // Remember where it actually answered, so the next restart can fall
      // straight back here instead of sweeping again.
      if (this._gatewayHost && this.getStoreValue('gatewayIpVerified') !== this._gatewayHost) {
        await this.setStoreValue('gatewayIpVerified', this._gatewayHost).catch(() => {});
      }
      return this._gatewayHost;
    }

    const tried = new Set([this._gatewayHost].filter(Boolean));
    const candidates = [
      this.getStoreValue('gatewayIpVerified'),
      this.getSetting('gateway_ip'),
      this.getStoreValue('gatewayIp'),
      this.homey.settings.get('saved_gateway_ip'),
    ].filter((ip) => ip && !tried.has(ip));

    for (const ip of candidates) {
      if (tried.has(ip)) continue;
      tried.add(ip);
      this.log('Gateway silent at ' + (this._gatewayHost || '?') + ' - trying ' + ip);
      if (await this._adoptGateway(ip)) return ip;
    }

    if (!allowScan) return null;
    if (Date.now() - (this._gatewayScanAt || 0) < GATEWAY_RESCAN_MIN_MS) return null;
    this._gatewayScanAt = Date.now();

    let base = null;
    try {
      base = subnetBaseFromAddress(await this.homey.cloud.getLocalAddress());
    } catch (err) {
      this.log('Could not read Homey local address: ' + err.message);
    }
    if (!base) base = subnetBaseFromAddress(known);
    if (!base) return null;

    this.log('Gateway not on any known address - sweeping ' + base + '0/24');
    let found = [];
    try {
      found = await discoverGateways({
        subnetBase: base,
        log:   (...args) => this.log(...args),
        error: (...args) => this.error(...args),
      });
    } catch (err) {
      this.error('Gateway sweep failed: ' + err.message);
      return null;
    }

    // Only a stick that actually answered its protocol - an open port alone is
    // a candidate, not a gateway, and adopting one would swap a dead address
    // for a silent one.
    for (const hit of found) {
      if (!hit.verified || tried.has(hit.ip)) continue;
      tried.add(hit.ip);
      if (await this._adoptGateway(hit.ip)) {
        await this._notifyGatewayMoved(hit.ip);
        return hit.ip;
      }
    }
    this.log('Sweep found no gateway that answers');
    return null;
  }

  /** Point the connection at `ip`, and keep it only if the stick answers there. */
  async _adoptGateway(ip) {
    const previous = this._gatewayHost;
    this._createHybrid(ip);
    if (!await this._hybrid.probeLocal().catch(() => false)) {
      this._createHybrid();            // back to whatever was configured
      return false;
    }
    this._gatewayOverride = ip;
    this.log('Gateway answers at ' + ip + ' (was ' + (previous || 'unset') + ')');
    await this.setStoreValue('gatewayIpVerified', ip).catch(() => {});
    this.homey.settings.set('saved_gateway_ip', ip);
    return true;
  }

  async _notifyGatewayMoved(ip) {
    try {
      await this.homey.notifications.createNotification({
        // Homey's __() does not substitute tokens, so do it here.
        excerpt: String(this.homey.__('errors.gateway_moved')).replace('{{ip}}', ip),
      });
    } catch (err) {
      this.error('Could not raise the gateway notification: ' + err.message);
    }
  }

  _startGatewayWatch() {
    if (this._gatewayWatch) this.homey.clearInterval(this._gatewayWatch);
    this._gatewayWatch = this.homey.setInterval(() => {
      this._ensureGatewayReachable().catch(() => {});
    }, GATEWAY_WATCH_MS);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('gateway_ip') || changedKeys.includes('cloud_api_url')
      || changedKeys.includes('station_id')) {
      this.log('Connection settings changed — reinitialising');
      // The user just named an address: drop the discovered one so their choice
      // is tried first. If it turns out to be dead, the recovery finds the stick
      // again by itself rather than leaving the device stranded.
      this._gatewayOverride = null;
      this._createHybrid(undefined, newSettings);
      this._ensureGatewayReachable()
        .catch(() => {})
        .finally(() => this._fetchGatewayInfo());
    }
    if (changedKeys.includes('poll_interval')) {
      this.log('Poll interval changed to ' + newSettings.poll_interval + 's');
      this._startPolling();
    }
  }

  async _migrateCapabilities() {
    // Remove obsolete capabilities FIRST: a leftover capability that is no
    // longer defined in the manifest leaves the device in an invalid state and
    // makes subsequent addCapability calls fail.
    for (const capability of REMOVED_CAPABILITIES) {
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

  _getPollMs() {
    const seconds = this.getSetting('poll_interval') || 60;
    return Math.max(30, Math.min(300, seconds)) * 1000;
  }

  _startPolling() {
    this._stopPolling();
    const ms = this._getPollMs();
    this._pollInterval = this.homey.setInterval(
      () => this._poll().catch(err => this.error('Poll interval failed: ' + err.message)),
      ms,
    );
    this.log('Polling every ' + (ms / 1000) + 's');
  }

  _stopPolling() {
    if (this._pollInterval) {
      this.homey.clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  /**
   * Temporarily halt polling while something else needs exclusive access to
   * the stick (the register scan on the settings page). The stick handles only
   * one conversation at a time, so a scan racing the poll produces timeouts
   * and misdelivered responses. Resumes automatically after `ms` as a safety
   * net in case the caller never resumes.
   */
  pausePolling(ms = 120_000) {
    this._stopPolling();
    this._clearFollowupPolls();
    if (this._pausePollingTimer) this.homey.clearTimeout(this._pausePollingTimer);
    this._pausePollingTimer = this.homey.setTimeout(() => this.resumePolling(), ms);
    this.log('Polling paused (register scan)');
  }

  resumePolling() {
    if (this._pausePollingTimer) {
      this.homey.clearTimeout(this._pausePollingTimer);
      this._pausePollingTimer = null;
    }
    if (!this._pollInterval) {
      this._startPolling();
      this.log('Polling resumed');
    }
  }

  // Human-readable charge/discharge status for the device tile, derived from
  // battery power (measure_power: + = charging, − = discharging).
  _batteryFlowText(power) {
    const w = Number(power);
    if (isNaN(w)) return null;
    const IDLE_W = 10; // treat near-zero flow as idle
    if (Math.abs(w) < IDLE_W) return this.homey.__('flow.idle');
    const verb = w > 0 ? this.homey.__('flow.charging') : this.homey.__('flow.discharging');
    return `${verb} ${Math.abs(Math.round(w))} W`;
  }

  /**
   * Set a setting that belongs to the active battery mode, or blank it when
   * that mode does not have it. Blanking is deliberate: leaving the previous
   * mode's number there is worse than showing nothing, because it reads as a
   * setting that applies when it does not.
   */
  async _setPerModeSetting(capability, field, value) {
    const supported = !this._modeSupports || this._modeSupports[field] !== false;
    if (!supported) return this._blankCapability(capability);
    await this._setCapabilitySafe(capability, value);
    const tile = SETTING_VALUE_CAPABILITY[capability];
    if (tile) await this._setCapabilitySafe(tile, value);
  }

  async _blankCapability(capability) {
    for (const cap of [capability, SETTING_VALUE_CAPABILITY[capability]]) {
      if (!cap || !this.hasCapability(cap)) continue;
      if (this.getCapabilityValue(cap) === null) continue;
      try {
        await this.setCapabilityValue(cap, null);
      } catch (err) {
        this.error(`Could not blank ${cap}: ${err.message}`);
      }
    }
  }

  async _setCapabilitySafe(capability, value) {
    if (value === null || value === undefined) return;
    if (!this.hasCapability(capability)) return;
    try {
      await this.setCapabilityValue(capability, value);
    } catch (err) {
      this.error('setCapabilityValue(' + capability + ') failed: ' + err.message);
    }
  }

  /**
   * The day's price plan, straight from Frank Energie's public API.
   *
   * Recomputed on every call rather than cached: the prices themselves are
   * fetched once a day, but which of them is 'now' changes on the hour, and a
   * Flow condition must never answer for the previous hour.
   */
  async getPricePlan() {
    if (this.getSetting('price_enabled') === false) return null;
    return this._prices.getPlan(this._priceOptions());
  }

  /**
   * A Flow reporting what the other batteries on this meter are doing, because
   * the app cannot see them itself. Call it while the state holds, not once when
   * it starts: the report expires on its own.
   */
  reportOtherBattery(state) {
    if (!Object.prototype.hasOwnProperty.call(this._otherBatteryReports, state)) {
      throw new Error(`Unknown battery state: ${state}`);
    }
    this._otherBatteryReports[state] = Date.now();
  }

  /** True while a report of that state is still fresh. */
  otherBatteryIs(state) {
    const at = this._otherBatteryReports[state] || 0;
    return Date.now() - at < OTHER_BATTERY_TTL_MS;
  }
  /** The whole day for the settings page, including the hours still to come. */
  async getPriceCurve() {
    if (this.getSetting('price_enabled') === false) return null;
    return this._prices.getCurve(this._priceOptions());
  }
  /**
   * Aim the Force Charge target at what the coming expensive hours will ask for,
   * instead of at a fixed level. Buying past that costs a cycle for energy the
   * day has no use for, and fills the room the sun was going to use for free.
   */
  async chargeToPlan() {
    const plan = await this.getPricePlan();
    if (!plan || !Number.isFinite(plan.chargeTarget)) {
      throw new Error(this.homey.__('errors.no_target'));
    }

    const current = this.getCapabilityValue('hoymiles_reserve_soc_forcecharge');
    if (Number.isFinite(current) && Math.abs(current - plan.chargeTarget) <= TARGET_TOLERANCE_PCT) {
      this.log(`Charge target already ${current}% (plan says ${plan.chargeTarget}%) - no write`);
      return null;
    }

    await this._hybrid.setReserveSocForMode(5, plan.chargeTarget);
    this._refreshLocalSettings().catch(() => {});
    this._scheduleLivePollBurst();
    return plan.chargeTarget;
  }
  /** Settings are kept in ct/kWh and percent; the plan works in EUR/kWh. */
  _priceOptions() {
    const cents = (key, fallback) => {
      const value = this.getSetting(key);
      return Number.isFinite(value) ? value / 100 : fallback;
    };
    const roundTrip = this.getSetting('price_round_trip');
    const capacity = this.getSetting('price_capacity_kwh');
    return {
      ...this._batteryState(Number.isFinite(capacity) ? capacity : FrankPrices.DEFAULTS.capacityKwh),
      wearCost:   cents('price_wear_cost',  FrankPrices.DEFAULTS.wearCost),
      minMargin:  cents('price_min_margin', FrankPrices.DEFAULTS.minMargin),
      buyBand:    cents('price_buy_band',   FrankPrices.DEFAULTS.buyBand),
      sellBand:   cents('price_sell_band',  FrankPrices.DEFAULTS.sellBand),
      feedInPenalty: cents('price_feed_in_penalty', FrankPrices.DEFAULTS.feedInPenalty),
      floorSoc:   Number.isFinite(this.getSetting('price_floor_soc'))
        ? this.getSetting('price_floor_soc')
        : FrankPrices.DEFAULTS.floorSoc,
      capacityKwh: Number.isFinite(this.getSetting('price_capacity_kwh'))
        ? this.getSetting('price_capacity_kwh')
        : FrankPrices.DEFAULTS.capacityKwh,
      efficiency: Number.isFinite(roundTrip) && roundTrip > 0
        ? roundTrip / 100
        : FrankPrices.DEFAULTS.efficiency,
    };
  }

  /**
   * What the battery has to spend and what the house is drawing. Both are
   * needed to work out how many of the coming expensive hours it can cover.
   * Either may be missing right after a restart; the plan then simply does not
   * rank, rather than assuming the battery is empty.
   */
  _batteryState(capacityKwh) {
    const soc = this.getCapabilityValue('measure_battery');
    const load = this.getCapabilityValue('hoymiles_load_power');
    const state = {};

    // Measured against the level the battery is ALLOWED to discharge to, never
    // against the reserve it happens to sit at. Using the live reserve makes the
    // answer depend on the very setting it is meant to drive: a reserve parked
    // above the charge reads as "nothing usable", so no hour is ever dear enough
    // to release it, so the reserve stays parked. Seen live, holding the battery
    // idle straight through the most expensive hour of the day.
    const configured = this.getSetting('price_floor_soc');
    const floor = Number.isFinite(configured) ? configured : 30;
    if (Number.isFinite(soc)) {
      state.usableKwh = Math.max(0, (soc - floor) / 100 * capacityKwh);
    }
    // The load reading is taken at the grid connection, so anything else on the
    // meter lands in it — here a set of batteries traded by the supplier on a
    // separate contract. Five kilowatts of somebody else's trade makes the house
    // look ravenous and shrinks the hours this battery thinks it can cover. A
    // configured figure overrides the measurement for exactly that reason.
    const assumed = this.getSetting('price_load_kw');
    if (Number.isFinite(assumed) && assumed > 0) state.loadKw = assumed;
    else if (Number.isFinite(load)) state.loadKw = load / 1000;
    return state;
  }
  async _refreshPricePlan() {
    if (this.getSetting('price_enabled') === false) return;
    const now = Date.now();
    if (now - this._lastPriceRefresh < PRICE_REFRESH_MS) return;
    this._lastPriceRefresh = now;

    const plan = await this.getPricePlan().catch((err) => {
      this.error('Price plan failed: ' + err.message);
      return null;
    });
    this._pricePlan = plan;

    if (!plan) {
      await this._setCapabilitySafe('hoymiles_price_plan', this.homey.__('price.unknown'));
      return;
    }

    const ct = (value) => Math.round(value * 1000) / 10;
    await this._setCapabilitySafe('hoymiles_price_now',        ct(plan.priceNow));
    await this._setCapabilitySafe('hoymiles_price_market_now', ct(plan.marketNow));
    await this._setCapabilitySafe('hoymiles_price_charge_target', plan.chargeTarget);
    await this._setCapabilitySafe('hoymiles_price_low_today',  ct(plan.dayLow));
    await this._setCapabilitySafe('hoymiles_price_high_today', ct(plan.dayHigh));
    await this._setCapabilitySafe('hoymiles_price_plan',       this._pricePlanText(plan));
  }

  /** One line for the tile: what to do, and the price that decides it. */
  _pricePlanText(plan) {
    const buyCeiling = plan.dayLow + (this._priceOptions().buyBand || 0);
    const price = ['buy', 'hold'].includes(plan.action) ? buyCeiling : plan.dischargeFloor;
    // Substituted here rather than handed to __(): Homey's i18n leaves the
    // {{price}} placeholder standing, which put it on the tile verbatim.
    return String(this.homey.__('price.' + plan.action))
      .replace('{{price}}', this._formatCents(price));
  }

  _formatCents(euroPerKwh) {
    const text = (euroPerKwh * 100).toFixed(1);
    let language = 'en';
    try {
      language = this.homey.i18n.getLanguage() || 'en';
    } catch (err) {
      // Older firmware without i18n.getLanguage: the dot is a safe default.
    }
    return language === 'nl' ? text.replace('.', ',') : text;
  }
  async _poll() {
    if (this._pollInFlight) return;
    this._pollInFlight = true;
    try {
      const data = await this._hybrid.getData();

      await this._setCapabilitySafe('measure_power',                data.batteryPower);
      await this._setCapabilitySafe('hoymiles_battery_flow',        this._batteryFlowText(data.batteryPower));
      await this._setCapabilitySafe('measure_voltage',              data.batteryVoltage);
      await this._setCapabilitySafe('measure_current',              data.batteryCurrent);
      await this._setCapabilitySafe('hoymiles_smartport_power',     data.pvPower);
      await this._setCapabilitySafe('measure_battery',              data.batterySoc);
      await this._setCapabilitySafe('hoymiles_grid_power',          data.gridPower);
      await this._setCapabilitySafe('hoymiles_load_power',          data.loadPower);
      await this._setCapabilitySafe('hoymiles_daily_energy',        data.dailyEnergy);
      await this._setCapabilitySafe('hoymiles_monthly_energy',      data.monthlyEnergy);
      await this._setCapabilitySafe('hoymiles_yearly_energy',       data.yearlyEnergy);
      await this._setCapabilitySafe('hoymiles_total_energy',        data.totalEnergy);
      await this._setCapabilitySafe('meter_power.charged',          data.batteryInEnergy);
      await this._setCapabilitySafe('meter_power.discharged',       data.batteryOutEnergy);
      await this._setCapabilitySafe('hoymiles_co2_reduction',       data.co2Reduction);
      await this._setCapabilitySafe('hoymiles_connection_source',   data.source);
      await this._refreshLocalSettings();
      await this._refreshBmsData();
      await this._refreshPricePlan();
      await this._applyCloudMarkers(data.source);

      // The mode in the live payload is the CLOUD's, and it lags a switch by
      // minutes. Only use it when the stick is not supplying one, otherwise
      // every poll would overwrite the fresh local reading with a stale value
      // and the picker would flip between the two — which is exactly what it
      // did. Same rule as the settings refresh below.
      if (data.batteryMode !== null && data.batteryMode !== undefined
          && this._modeSource !== 'lokaal') {
        await this._updateBatteryMode(String(data.batteryMode), 'cloud');
      }

      // Refresh mode/reserve/max-power on their own slower cadence (the first
      // poll runs immediately since _lastSettingsRefresh starts at 0).
      const now = Date.now();
      if (now - this._lastSettingsRefresh >= SETTINGS_REFRESH_MS) {
        this._lastSettingsRefresh = now;
        this._refreshBatterySettings().catch(() => {});
      }

      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this.error('Poll failed: ' + err.message);
      try {
        await this.setUnavailable(this.homey.__('errors.poll_failed'));
      } catch (unavailableErr) {
        this.error('setUnavailable failed: ' + unavailableErr.message);
      }
    } finally {
      this._pollInFlight = false;
    }
  }

  _refreshBatterySettings() {
    if (this._settingsRefreshInFlight) return this._settingsRefreshInFlight;

    this._settingsRefreshInFlight = (async () => {
      // Any refresh (timed or right after a mode/slider change) resets the clock,
      // so the next timed refresh won't fire a redundant heavy read back-to-back.
      this._lastSettingsRefresh = Date.now();
      const settings = await this._hybrid.getBatterySettings();
      if (settings) {
        // Only label this as the cloud when the mode did NOT come off the stick
        // this cycle; otherwise the tile would flip between the two labels.
        // Only when the stick is not supplying it. The cloud lags a mode change
        // by minutes, so applying it here would undo a switch that already
        // happened.
        if (settings.mode !== undefined && this._modeSource !== 'lokaal') {
          await this._updateBatteryMode(settings.mode, 'cloud');
        }

        // Reserve SOC and max SOC belong to whichever mode is active. When that
        // mode has no such setting, blank the tile instead of showing a value
        // borrowed from another mode's block — that borrowed number is what
        // made a "max charge level" of 85% appear while the active mode had
        // none. The charge/discharge power limits are NOT blanked: their titles
        // name their own mode, and pre-configuring them without switching is a
        // genuine local-Modbus capability.
        this._modeSupports = settings.supports || null;
        // The cloud reports one reserve SOC: the active mode's. That is not
        // ambiguous here — the same payload says which mode that is — so file it
        // under that mode's tile and leave the others to the Modbus read.
        // This is what keeps the tiles populated on a cloud-only install.
        const activeSlider = RESERVE_SOC_SLIDERS[Number(settings.mode)];
        if (activeSlider && typeof settings.reserveSoc === 'number') {
          await this._setCapabilitySafe(activeSlider, settings.reserveSoc);
          await this._setCapabilitySafe(SETTING_VALUE_CAPABILITY[activeSlider], settings.reserveSoc);
        }

        await this._setCapabilitySafe('hoymiles_max_charge_power',     settings.maxChargePower);
        await this._setCapabilitySafe('hoymiles_max_discharge_power',  settings.maxDischargePower);
        await this._setCapabilitySafe('hoymiles_meter_power',          settings.meterPower);

        // Mirror the three onto their read-only tiles on the device card.
        for (const [slider, tile] of Object.entries(SETTING_VALUE_CAPABILITY)) {
          await this._setCapabilitySafe(tile, this.getCapabilityValue(slider));
        }

        // Remember which of them came off the stick, so the cloud marker below
        // labels only the ones that really lag.
        this._localSettingCaps = new Set(
          (settings.localFields || [])
            .map(field => LOCAL_SETTING_CAPABILITY[field])
            .filter(Boolean)
        );
      }

      const profit = await this._hybrid.getEpsProfit();
      if (profit) {
        await this._setCapabilitySafe('hoymiles_profit_today', profit.todayProfit);
        await this._setCapabilitySafe('hoymiles_profit_total', profit.totalProfit);
      }
    })().finally(() => {
      this._settingsRefreshInFlight = null;
    });

    return this._settingsRefreshInFlight;
  }

  // Called by the driver's flow action cards
  async setPeakShaving(settings) {
    await this._hybrid.setPeakShaving(settings);
    this._refreshBatterySettings().catch(() => {});
    this._scheduleLivePollBurst();
  }

  async setRelayEnabled(enabled) {
    await this._hybrid.setRelayEnabled(enabled);
  }

  async setMaxPower(percent) {
    await this._hybrid.setMaxPower(percent);
    this._refreshBatterySettings().catch(() => {});
    this._scheduleLivePollBurst();
  }

  async setMaxChargePower(percent) {
    await this._hybrid.setMaxChargePower(percent);
    this._refreshBatterySettings().catch(() => {});
    this._scheduleLivePollBurst();
  }

  async setMaxDischargePower(percent) {
    await this._hybrid.setMaxDischargePower(percent);
    this._refreshBatterySettings().catch(() => {});
    this._scheduleLivePollBurst();
  }

  // Clamp the battery without switching modes — see HoymilesHybrid for why the
  // mode is deliberately left alone.
  async setChargeLimitLocal(percent) {
    await this._hybrid.setChargeLimitLocal(percent);
    this._refreshLocalSettings().catch(() => {});
    this._scheduleLivePollBurst();
  }

  async setDischargeLimitLocal(percent) {
    await this._hybrid.setDischargeLimitLocal(percent);
    this._refreshLocalSettings().catch(() => {});
    this._scheduleLivePollBurst();
  }

  /**
   * The Flow card's reserve SOC: whichever mode is active, which is the only
   * thing the cloud endpoint can express. The per-mode sliders are the precise
   * way to do this; this exists because the card predates them and Flows out
   * there already use it.
   */
  async setReserveSocActiveMode(percent) {
    await this._hybrid.setReserveSoc(percent);
    this._refreshBatterySettings().catch(() => {});
    this._scheduleLivePollBurst();
  }

  // The charge ceiling that binds in every mode — the fast way to stop a charge.
  async setMaxSocLocal(percent) {
    await this._hybrid.setMaxSocLocal(percent);
    this._refreshLocalSettings().catch(() => {});
    this._scheduleLivePollBurst();
  }

  // The reserve of a named mode, active or not. Refreshes the local settings
  // afterwards so the matching slider shows what the register now holds rather
  // than what we asked for — if the stick clamped it, the tile says so.
  async setReserveSocForMode(mode, percent) {
    await this._hybrid.setReserveSocForMode(mode, percent);
    this._refreshLocalSettings().catch(() => {});
    this._scheduleLivePollBurst();
  }

  /**
   * Stop the battery discharging without inviting it to charge.
   *
   * In Self-Consumption the reserve is not only a floor: the inverter also
   * charges UP to it, from the grid when there is no sun. Parking the reserve
   * at 100% to hold energy back therefore buys energy at the very price you
   * were trying to avoid. Setting it to the charge already on board holds the
   * battery still instead — nothing to discharge to, nothing to charge up to.
   */
  async holdBatteryHere() {
    const soc = this.getCapabilityValue('measure_battery');
    if (!Number.isFinite(soc)) throw new Error(this.homey.__('errors.no_soc'));

    // Floor, never round: one percent above the real charge is still a buy order.
    const level = Math.max(5, Math.min(100, Math.floor(soc)));
    const current = this.getCapabilityValue('hoymiles_reserve_soc_selfuse');

    // Every write lands in EEPROM, which wears out, so only write when it changes
    // something. A reserve already just under the charge is holding fine — chasing
    // the last percent as the reading drifts would write all day for nothing. A
    // reserve ABOVE the charge is corrected at once whatever the gap: that is not
    // a hold but a standing order to buy up to it.
    if (Number.isFinite(current)
        && current <= level && level - current <= HOLD_TOLERANCE_PCT) {
      this.log(`Hold: reserve ${current}% already holds ${soc}% - no write`);
      return null;
    }

    await this._hybrid.setReserveSocForMode(1, level);
    this._refreshLocalSettings().catch(() => {});
    this._scheduleLivePollBurst();
    return level;
  }
  async setMaxSoc(percent) {
    await this._hybrid.setMaxSoc(percent);
    this._refreshBatterySettings().catch(() => {});
    this._scheduleLivePollBurst();
  }

  async setGridLimit(watts) {
    await this._hybrid.setGridLimit(watts);
    this._refreshBatterySettings().catch(() => {});
    this._scheduleLivePollBurst();
  }

  async setTouPeriod(period) {
    await this._hybrid.setTouPeriod(period);
    this._refreshBatterySettings().catch(() => {});
    this._scheduleLivePollBurst();
  }

  async setPowerLimit(limitPercent) {
    const limit = Math.round(Number(limitPercent));
    if (isNaN(limit) || limit < 2 || limit > 100) {
      throw new Error('Invalid power limit (2-100%): ' + limitPercent);
    }

    // Skip redundant writes — the inverter stores the limit in EEPROM, so
    // re-writing the same value only wastes a limited erase/write budget.
    if (this.getStoreValue('power_limit_last') === limit) {
      this.log(`[EEPROM] power limit already ${limit}% — skipping write`);
      return;
    }

    // Daily write budget to protect the EEPROM against runaway automations.
    const today = new Date().toISOString().slice(0, 10);
    let day   = this.getStoreValue('power_limit_day');
    let count = this.getStoreValue('power_limit_count') || 0;
    if (day !== today) { day = today; count = 0; }
    if (count >= POWER_LIMIT_MAX_WRITES_PER_DAY) {
      throw new Error(
        `Power-limit write budget reached (${POWER_LIMIT_MAX_WRITES_PER_DAY}/day) to protect the inverter EEPROM. Try again tomorrow.`,
      );
    }

    await this._hybrid.setPowerLimit(limit);

    await this.setStoreValue('power_limit_last', limit);
    await this.setStoreValue('power_limit_day', day);
    await this.setStoreValue('power_limit_count', count + 1);
    this.log(`[EEPROM] power limit -> ${limit}% (write ${count + 1}/${POWER_LIMIT_MAX_WRITES_PER_DAY} today)`);
  }

  async setInverterState(serial, on) {
    await this._hybrid.setInverterState(serial, on);
  }

  async _updateBatteryMode(mode, source) {
    await this._setCapabilitySafe('hoymiles_battery_mode', mode);

    // One tile that answers "what is it doing, and how fast can I change it":
    // the mode, the battery power beside it, and the app's own cloud marker when
    // the value came from the cloud rather than the stick. The marker is used
    // instead of spelling out the source, because the words did not fit.
    if (source) this._modeSource = source;
    const name = SHORT_MODE_NAMES[Number(mode)] || BATTERY_MODES[Number(mode)] || mode;

    // Keep this SHORT. The status indicator truncates around eighteen characters,
    // and a cut-off label is worse than an abbreviation: "F-Discharge · -252…"
    // hides both which mode it is and what the battery is doing. kW above a
    // kilowatt, plain watts below it.
    const power = this.getCapabilityValue('measure_power');
    let text = String(name);
    if (typeof power === 'number') {
      text += ' ' + (Math.abs(power) >= 1000
        ? (power / 1000).toFixed(1) + ' kW'
        : Math.round(power) + ' W');
    }
    await this._setCapabilitySafe('hoymiles_battery_mode_value',
      text + (this._modeSource === 'cloud' ? CLOUD_MARKER : ''));

    // Persist it so a restart before the first poll still knows which mode is
    // active — that is what decides where a local reserve-SOC write goes. Since
    // v1.1.2 the mode is also read straight from the stick every poll, so this
    // store is only a cold-start fallback rather than the sole source it was.
    if (mode !== undefined && mode !== null && mode !== this.getStoreValue('last_mode')) {
      await this.setStoreValue('last_mode', mode).catch(() => {});
    }

    if (this._prevBatteryMode !== null && mode !== this._prevBatteryMode) {
      const modeName = BATTERY_MODES[Number(mode)] || mode;
      this.homey.flow.getDeviceTriggerCard('battery_mode_changed')
        .trigger(this, { mode: modeName })
        .catch(err => this.error('Trigger failed: ' + err.message));
    }
    this._prevBatteryMode = mode;
  }

  async _fetchGatewayInfo() {
    try {
      const info = await this._hybrid.getGatewayInfo();
      if (!info) return;
      const updates = {};
      if (info.dtuSn)       updates.dtu_serial       = info.dtuSn;
      if (info.softwareVer) updates.firmware_version  = info.softwareVer;
      if (info.deviceVer)   updates.hardware_version  = info.deviceVer;
      if (info.model)       updates.gateway_model     = info.model;
      if (info.devices && info.devices.length) {
        updates.system_devices = this._formatDeviceList(info.devices);
      }
      if (Object.keys(updates).length > 0) {
        await this.setSettings(updates);
        this.log('Gateway info updated: ' + JSON.stringify(updates));
      }
    } catch (err) {
      this.log('Could not fetch gateway info: ' + err.message);
    }
  }

  _formatDeviceList(devices) {
    // One block per device so every field is visible and the SN can be copied.
    // The textarea setting renders the line breaks and is selectable/copyable.
    return devices.map((d) => {
      const header = [d.type || 'Device', d.status, d.gen].filter(Boolean).join(' · ');
      const lines  = [header];
      const add = (label, value) => { if (value) lines.push(`  ${label}: ${value}`); };
      add('SN', d.serial);
      add('Model', d.model);
      add('Firmware', d.softwareVer);
      add('Hardware', d.hardwareVer);
      return lines.join('\n');
    }).join('\n\n');
  }

  // settingsOverride exists for onSettings: while that handler runs, Homey has
  // NOT stored the new values yet, so getSettings() still returns the previous
  // ones and a reinit here would rebuild the connection from the setting the
  // user just replaced — one save behind, every time.
  _createHybrid(hostOverride, settingsOverride) {
    const store     = this.getStore();
    const settings  = settingsOverride || this.getSettings();
    // An address proven to answer wins over everything, because a configured
    // address that is not there is worse than useless: it costs a timeout per
    // read and locks out the one that works. Otherwise the device setting wins,
    // then the store, then the app-wide saved IP.
    const gatewayIp = hostOverride
      || this._gatewayOverride
      || (settings && settings.gateway_ip)
      || store.gatewayIp
      || this.homey.settings.get('saved_gateway_ip')
      || null;
    this._gatewayHost = gatewayIp;

    const baseUrl = (settings && settings.cloud_api_url)
      || this.homey.settings.get('cloud_api_url')
      || undefined;

    let localProtocol = store.localProtocol
      || this.homey.settings.get('local_protocol')
      || 'modbus';
    if (localProtocol !== 'native' && localProtocol !== 'auto') localProtocol = 'modbus';

    // Device-specific credentials win; fall back to the app-wide saved login
    // (set on the app settings page or during pairing) — same pattern as the
    // gateway IP above. Without this a device paired local-only can never do
    // the cloud top-up, leaving grid/load/PV and the energy counters empty.
    const email    = store.email    || this.homey.settings.get('saved_email')    || undefined;
    const password = store.password || this.homey.settings.get('saved_password') || undefined;

    // Devices paired local-only get data.stationId = null, and device data is
    // immutable — so without an override the cloud is unreachable for them
    // forever. Let the optional station_id setting supply it instead of
    // forcing a re-pair (which would break existing Flows and Insights).
    const stationId = this.getData().stationId
      || (settings && settings.station_id ? Number(settings.station_id) : null)
      || undefined;

    this._hybrid = new HoymilesHybrid({
      gatewayIp,
      localPort:     this.homey.settings.get('local_port') || undefined,
      localProtocol,
      modbusUnitId:  this.homey.settings.get('modbus_unit_id') || 1,
      email,
      password,
      stationId,
      baseUrl,
      cloudApi:  this.homey.app.api,
      log:       this.log.bind(this),
      error:     this.error.bind(this),
    });

    // Hand back the mode we knew when we last ran. Without this a restart
    // during an internet outage would leave local writes unable to pick the
    // right per-mode register, precisely when the cloud cannot help.
    const storedMode = this.getStoreValue('last_mode');
    if (storedMode !== undefined && storedMode !== null) {
      this._hybrid.setKnownMode(storedMode);
    }
  }
}

module.exports = HiOneDevice;
