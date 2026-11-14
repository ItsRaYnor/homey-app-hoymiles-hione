'use strict';

const { Device } = require('homey');
const HoymilesHybrid = require('../../lib/HoymilesHybrid');
const { BATTERY_MODES } = require('../../lib/HoymilesApi');
const PricePlan = require('./parts/PricePlan');
const StateOfCharge = require('./parts/StateOfCharge');
const Gateway = require('./parts/Gateway');
const Capabilities = require('./parts/Capabilities');

// Battery mode / reserve / max-power use a slow async cloud command (a job
// read that can take ~30s), so they refresh on their own slower cadence —
// independent of the live poll interval (~60s). An in-app change still
// refreshes immediately (see the battery-mode capability listener).
// Heavy cloud settings (mode / reserve / max-power / EPS) — keep light live
// data on the normal poll interval (~60s) and refresh this slower.
const SETTINGS_REFRESH_MS = 5 * 60_000; // 5 min

// How far the Self-Consumption reserve may sit below the charge before holding
// the battery rewrites it. Slack, so a drifting SOC reading does not spend an
// EEPROM write every few minutes; small enough that little can leak out first.
const HOLD_TOLERANCE_PCT = 3;

// Battery power below which a hold counts as leaking: a discharge this size is
// real energy going out, not measurement noise around zero.
const HOLD_LEAK_W = 100;

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

// How long a mode read from the stick outranks the cloud. The cloud lags a
// local switch by minutes, so one failed local read must not hand the picker
// straight back to it: that showed Self-Consumption while the inverter was in
// Force Discharge. Only a stick that stays silent this long loses the say.
const LOCAL_MODE_TRUST_MS = 15 * 60_000;

// First entry of the mode picker; means "no change". See the mode listener.
const MODE_PLACEHOLDER = '0';

// Homey fails a capability listener with "Timeout after 10000ms" if it has not
// resolved in ten seconds. Our cloud calls carry a fifteen-second HTTP timeout
// and setMaxSoc makes two of them back to back, so simply awaiting the write
// cannot meet that budget — the user gets a timeout even when the write goes on
// to succeed. Reported live on 2026-09-06, moving the max charge level slider.
const SETTING_LISTENER_BUDGET_MS = 8_000;

// The local power limit is persisted to the inverter's EEPROM on every write.
// Cap automated writes per day and skip no-op writes to limit chip wear.
const POWER_LIMIT_MAX_WRITES_PER_DAY = 10;

// One failed poll is a hiccup, not an outage: a dropped packet or a slow cloud
// answer used to mark the device unavailable for a minute, and every Flow
// that touched it in that minute failed. Only this many misses in a row do.
// A device that has not managed a single poll since it started is different:
// that is a wrong address or a dead login, and it shows at once.
const POLL_FAILURES_BEFORE_UNAVAILABLE = 3;

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

class HiOneDevice extends Device {

  async onInit() {
    this.log('HiOne device initialising...');
    this._prevBatteryMode = null;
    this._lastSettingsRefresh = 0;
    this._followupTimers = [];
    this._modeChangeTimer = null;
    this._lastModeApplyAt = 0;
    this._pollInFlight = false;
    this._pollFailures = 0;
    this._pollEverSucceeded = false;
    this._settingsRefreshInFlight = null;
    this._lastPriceRefresh = 0;
    this._otherBatteryReports = { charging: 0, discharging: 0 };
    this._pricePlan = null;
    this._createPrices();

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
      if (this._modeChangeTimer) this.homey.clearTimeout(this._modeChangeTimer);
      this._modeChangeTimer = null;

      // The Homey app opens this picker on its FIRST entry and reports that
      // entry as a choice, whatever the mode is - measured: opening the card
      // during Force Discharge switched the battery to Self-Consumption. So the
      // first entry is a placeholder that changes nothing. Landing on it also
      // cancels a choice still waiting out its delay, and the tile is put back
      // on the mode that is really running.
      if (String(value) === MODE_PLACEHOLDER) {
        this._pendingMode = null;
        this.homey.setTimeout(() => {
          const active = (this._hybrid && this._hybrid.getKnownMode()) ?? this.getStoreValue('last_mode');
          if (active !== null && active !== undefined) {
            this._setCapabilitySafe('hoymiles_battery_mode', String(active)).catch(() => {});
          }
        }, 500);
        return;
      }

      this._pendingMode = value;
      const cooldown = this._hybrid && this._hybrid.isModbusActive() ? 0 : MODE_MIN_INTERVAL_MS;
      const cooldownLeft = this._lastModeApplyAt + cooldown - Date.now();
      const delay = Math.max(MODE_APPLY_DELAY_MS, cooldownLeft);
      this._modeChangeTimer = this.homey.setTimeout(() => {
        this._modeChangeTimer = null;
        // Settling on the mode that is already running is not a change. Opening
        // the picker and closing it again must never cost a mode write.
        const active = this._hybrid && this._hybrid.getKnownMode();
        if (this._localModeFresh() && active !== null
            && String(active) === String(this._pendingMode)) {
          this.log(`Mode ${this._pendingMode} already active - no write`);
          return;
        }
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
          await this._writeReserveSoc(Number(mode), value);
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

    this._registerLocalOnlyListeners();

    this.registerCapabilityListener('hoymiles_meter_power',
      this._settingListener('Grid limit', (value) => this._hybrid.setGridLimit(value),
        'labels.grid_limit'));

    this._startPolling();
    await this._poll();
    this.log('HiOne device ready');
  }

  /**
   * The slider a cloud-only device does not have. Registered when the tile is
   * there, and again after the device is switched back to local - listeners are
   * otherwise only set up once, at start.
   */
  _registerLocalOnlyListeners() {
    if (this._maxSocListener || !this.hasCapability('hoymiles_max_soc_local')) return;
    this._maxSocListener = true;
    this.registerCapabilityListener('hoymiles_max_soc_local',
      this._settingListener('Local charge ceiling', async (value) => {
        await this._hybrid.setMaxSocLocal(value);
        await this._setCapabilitySafe(SETTING_VALUE_CAPABILITY.hoymiles_max_soc_local, value);
      }, 'labels.charge_ceiling'));
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
    this._localModeAttempted = true;
    if (localMode !== null && localMode !== undefined) {
      this._lastLocalModeAt = Date.now();
      await this._updateBatteryMode(String(localMode), 'lokaal');
    } else if (!this._localModeFresh()) {
      // The stick has been silent for a while: hand the mode back to the cloud
      // rather than let a stale 'lokaal' label keep the cloud value out. A
      // single missed read does not count - see LOCAL_MODE_TRUST_MS.
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

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('connection_mode')) {
      // Add or drop the tiles only the stick can fill. newSettings, because
      // getSettings() still returns the old values while this handler runs.
      await this._migrateCapabilities(newSettings);
      this._registerLocalOnlyListeners();
    }
    if (changedKeys.includes('gateway_ip') || changedKeys.includes('cloud_api_url')
      || changedKeys.includes('station_id') || changedKeys.includes('connection_mode')) {
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
    if (changedKeys.some((key) => ['price_zone', 'price_surcharge', 'price_vat'].includes(key))) {
      this.log('Price source settings changed — fetching prices again');
      this._createPrices(newSettings);
    }
    if (changedKeys.includes('poll_interval')) {
      this.log('Poll interval changed to ' + newSettings.poll_interval + 's');
      this._startPolling();
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
    // Mirror the mode as a number for Insights, from every place that sets it.
    // "0" is the picker's "choose a mode" placeholder, not a mode.
    if (capability === 'hoymiles_battery_mode') {
      const mode = Number(value);
      if (Number.isInteger(mode) && mode >= 1 && mode <= 9) {
        await this._setCapabilitySafe('hoymiles_battery_mode_number', mode);
      }
    }
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
      await this._setCapabilitySafe('measure_battery',              this._trustedSoc(data));
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
          && this._cloudMayReportMode()) {
        await this._updateBatteryMode(String(data.batteryMode), 'cloud');
      }

      // Refresh mode/reserve/max-power on their own slower cadence (the first
      // poll runs immediately since _lastSettingsRefresh starts at 0).
      const now = Date.now();
      if (now - this._lastSettingsRefresh >= SETTINGS_REFRESH_MS) {
        this._lastSettingsRefresh = now;
        this._refreshBatterySettings().catch(() => {});
      }

      this._pollFailures = 0;
      this._pollEverSucceeded = true;
      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this._pollFailures += 1;
      this.error(`Poll failed (${this._pollFailures} in a row): ${err.message}`);
      if (this._pollEverSucceeded && this._pollFailures < POLL_FAILURES_BEFORE_UNAVAILABLE) return;
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
        if (settings.mode !== undefined && this._cloudMayReportMode()) {
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

  /**
   * True for a device set to "cloud only": typically a second installation on
   * the same S-Miles account whose stick is not on this network. Such a device
   * must never borrow the app-wide stick address - that stick belongs to the
   * other installation, and reading it put this Homey's battery on its tiles.
   */
  _isCloudOnly(settingsOverride) {
    const settings = settingsOverride || this.getSettings() || {};
    return settings.connection_mode === 'cloud';
  }

  /** Refuse a stick-only action on a cloud-only device, in words the user reads. */
  _requireLocal() {
    if (this._isCloudOnly()) throw new Error(this.homey.__('errors.cloud_only'));
  }

  /**
   * A reserve SOC for a named mode. Locally that is any mode's own register.
   * The cloud can only change the mode that is running, so a cloud-only device
   * accepts exactly that case and refuses the rest instead of writing the value
   * into whichever mode happens to be active.
   */
  async _writeReserveSoc(mode, percent) {
    if (!this._isCloudOnly()) {
      await this._hybrid.setReserveSocForMode(mode, percent);
      return;
    }
    const active = this._hybrid.getKnownMode();
    if (active === null || Number(active) !== Number(mode)) {
      throw new Error(this.homey.__('errors.cloud_only_reserve'));
    }
    await this._hybrid.setReserveSoc(percent);
    this._refreshBatterySettings().catch(() => {});
  }

  // Clamp the battery without switching modes — see HoymilesHybrid for why the
  // mode is deliberately left alone.
  async setChargeLimitLocal(percent) {
    this._requireLocal();
    await this._hybrid.setChargeLimitLocal(percent);
    this._refreshLocalSettings().catch(() => {});
    this._scheduleLivePollBurst();
  }

  async setDischargeLimitLocal(percent) {
    this._requireLocal();
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
    await this._writeReserveSoc(mode, percent);
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
    // Force Charge runs to its own target and never reads this register, so a
    // hold there stops nothing - measured 2026-10-27: the Sessy guards held every
    // minute through a 6.4 kW charge and the battery never slowed. All the hold
    // did was chase the Self-Consumption reserve up behind the rising charge, 30
    // to 50% in ninety minutes at an EEPROM write per step, and leave it parked
    // high for when the charge ends. The tile can lag a switch made outside this
    // app, though, so a battery that is discharging is held whatever it says:
    // Force Charge does not discharge.
    const draining = (this.getCapabilityValue('measure_power') || 0) < -HOLD_LEAK_W;
    if (String(this.getCapabilityValue('hoymiles_battery_mode')) === '5' && !draining) {
      this.log('Hold: Force Charge running - reserve left alone, no write');
      return null;
    }

    const soc = this.getCapabilityValue('measure_battery');
    if (!Number.isFinite(soc)) throw new Error(this.homey.__('errors.no_soc'));

    // Floor, never round: one percent above the real charge is still a buy order.
    const level = Math.max(5, Math.min(100, Math.floor(soc)));
    // The read-only tile, not the slider: the slider snaps to steps of five, so a
    // register at 57 reads as 55 there and the gap below looks wider than it is.
    const tile = this.getCapabilityValue(SETTING_VALUE_CAPABILITY.hoymiles_reserve_soc_selfuse);
    const current = Number.isFinite(tile) ? tile : this.getCapabilityValue('hoymiles_reserve_soc_selfuse');

    // Every write lands in EEPROM, which wears out, so only write when it changes
    // something. A reserve already just under the charge is holding fine — chasing
    // the last percent as the reading drifts would write all day for nothing. A
    // reserve ABOVE the charge is corrected at once whatever the gap: that is not
    // a hold but a standing order to buy up to it.
    // No slack while the battery is actually discharging, though: then the gap is
    // energy leaving right now - measured 2026-10-03, 2.4 kW running into three
    // charging Sessy's because a reserve 1% below the charge counted as holding.
    const discharging = (this.getCapabilityValue('measure_power') || 0) < -HOLD_LEAK_W;
    const slack = discharging ? 0 : HOLD_TOLERANCE_PCT;
    // One percent above is tolerated too. The charge reads as a whole number, so
    // 57.9% shows as 57 seconds after the reserve went to 58; correcting that
    // "excess" lowered the reserve a percent per minute and let the battery
    // walk down with it (seen the same day, within a minute of the fix above).
    // A one-percent top-up is the price; an endless slide is not.
    if (Number.isFinite(current)
        && current <= level + 1 && level - current <= slack) {
      this.log(`Hold: reserve ${current}% already holds ${soc}% - no write`);
      return null;
    }

    await this._writeReserveSoc(1, level);
    this._refreshLocalSettings().catch(() => {});
    this._scheduleLivePollBurst();

    // Fires only on a real write, so a notification hung on it does not repeat
    // every time a Flow re-checks a battery that is already held.
    this.homey.flow.getDeviceTriggerCard('battery_held')
      .trigger(this, {
        reserve: level,
        previous: Number.isFinite(current) ? current : level,
        soc: Math.round(soc),
      })
      .catch(err => this.error('Trigger failed: ' + err.message));
    return level;
  }

  /**
   * Force Charge to `soc`% at `power`% - one card for what used to take four,
   * with delays between them so they landed in the right order.
   *
   * The order is the point. Target first, so the mode never starts charging
   * towards yesterday's target; the ceiling open next, because a closed one
   * silently stops the charge; power before the mode, so it never starts at the
   * old rate. The power goes through the local limit on purpose: the other
   * route sends it via the cloud while the station is not yet in Force Charge,
   * and the cloud switches the mode itself - minutes late and out of order.
   * Every write is skipped when the register already holds the value.
   */
  async startCharging(soc, power) {
    // Every step before the mode switch is a stick register. Over the cloud the
    // target would land in whichever mode is running, not in Force Charge.
    this._requireLocal();
    const target = Math.round(Math.max(0, Math.min(100, soc)));
    await this._hybrid.setReserveSocForMode(5, target);
    await this._hybrid.setMaxSocLocal(100);
    await this._hybrid.setChargeLimitLocal(power);
    await this._setModeNow(5);
    this._refreshLocalSettings().catch(() => {});
    this._scheduleLivePollBurst();
    return target;
  }

  /** startCharging to the level the price plan says the dear hours need. */
  async startChargingToPlan(power) {
    const plan = await this.getPricePlan();
    if (!plan || !Number.isFinite(plan.chargeTarget)) {
      throw new Error(this.homey.__('errors.no_target'));
    }
    return this.startCharging(plan.chargeTarget, power);
  }

  /**
   * Force Discharge down to `soc`% at `power`%. Floor first, so selling never
   * runs past an older, lower floor; power next, so it never starts at the old
   * rate; the mode last.
   */
  async startSelling(soc, power) {
    this._requireLocal();
    const floor = Math.round(Math.max(0, Math.min(100, soc)));
    await this._hybrid.setReserveSocForMode(6, floor);
    await this._hybrid.setDischargeLimitLocal(power);
    await this._setModeNow(6);
    this._refreshLocalSettings().catch(() => {});
    this._scheduleLivePollBurst();
    return floor;
  }

  /**
   * End a forced charge or sale: charge power to zero, then Self-Consumption.
   * The zero is the deliberate off switch for Force Charge, so a later switch
   * back into it does not resume at the old rate. Without a local connection
   * that write is skipped rather than failing the card - the mode switch is
   * what matters, and it has a cloud route.
   */
  async stopToSelfUse() {
    if (this._hybrid.isModbusActive()) {
      await this._hybrid.setChargeLimitLocal(0);
    }
    await this._setModeNow(1);
    this._refreshLocalSettings().catch(() => {});
    this._scheduleLivePollBurst();
  }

  /**
   * Switch the mode now and wait for it, for the cards above. The picker path
   * debounces for seconds and swallows errors, which is right for a finger on
   * a tile but wrong for a Flow step that the next step depends on. A choice
   * still waiting out the picker's debounce is dropped, so it cannot land
   * after this one and undo it.
   */
  async _setModeNow(mode) {
    if (this._modeChangeTimer) this.homey.clearTimeout(this._modeChangeTimer);
    this._modeChangeTimer = null;
    this._pendingMode = null;

    const active = this._hybrid.getKnownMode();
    if (this._localModeFresh() && active !== null && Number(active) === Number(mode)) {
      this.log(`Mode ${mode} already active - no write`);
      return;
    }
    this._lastModeApplyAt = Date.now();
    await this._hybrid.setBatteryMode(mode);
    // Conditions that read the tile must see the new mode on the very next run.
    await this._setCapabilitySafe('hoymiles_battery_mode', String(mode));
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

  /**
   * Put the running mode at the top of the picker.
   *
   * The Homey app opens this picker on its first entry and reports that entry
   * as a choice. With the running mode first, opening the card shows it and
   * the "choice" it reports is the mode already active - which the listener
   * leaves alone. The static list in app.json starts with a do-nothing
   * placeholder, so if this ever fails the picker is still harmless.
   */
  static modePickerValues(allValues, mode) {
    const real = allValues.filter((value) => value.id !== MODE_PLACEHOLDER);
    const current = real.find((value) => value.id === String(mode));
    if (!current) return null;
    return [current, ...real.filter((value) => value !== current)];
  }

  async _orderModePicker(mode) {
    if (mode === undefined || mode === null) return;
    if (this._pickerOrderedFor === String(mode)) return;
    const definition = this.homey.manifest
      && this.homey.manifest.capabilities
      && this.homey.manifest.capabilities.hoymiles_battery_mode;
    const values = definition && HiOneDevice.modePickerValues(definition.values || [], mode);
    if (!values) return;
    try {
      let options = {};
      try { options = this.getCapabilityOptions('hoymiles_battery_mode') || {}; } catch (_) { /* none set yet */ }
      await this.setCapabilityOptions('hoymiles_battery_mode', { ...options, values });
      this._pickerOrderedFor = String(mode);
    } catch (err) {
      this.error('Could not reorder the mode picker: ' + err.message);
    }
  }

  /** True while a mode read from the stick is recent enough to trust. */
  _localModeFresh() {
    return Number.isFinite(this._lastLocalModeAt)
      && Date.now() - this._lastLocalModeAt < LOCAL_MODE_TRUST_MS;
  }

  /**
   * Whether the cloud's mode may be shown. Never while the stick has spoken
   * recently, and never before the stick has had its first chance after a
   * start: the poll reads the cloud payload before the stick, and letting the
   * cloud go first put its stale mode on the picker for a moment on every
   * restart.
   */
  _cloudMayReportMode() {
    const modbus = this._hybrid && this._hybrid.isModbusActive();
    if (!modbus) return true;
    if (!this._localModeAttempted) return false;
    return !this._localModeFresh();
  }

  async _updateBatteryMode(mode, source) {
    await this._orderModePicker(mode);
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
    // A cloud-only device gets no address at all: the app-wide one is the stick
    // of ANOTHER installation, and falling back to it is what made a second
    // station show this Homey's battery.
    const gatewayIp = this._isCloudOnly(settings) ? null : (hostOverride
      || this._gatewayOverride
      || (settings && settings.gateway_ip)
      || store.gatewayIp
      || this.homey.settings.get('saved_gateway_ip')
      || null);
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

// The device is one class at runtime, written in several files: each part
// holds the methods of one concern, and they are copied onto the prototype
// here. A method in a part is called as this.method(), like any other.
for (const part of [PricePlan, StateOfCharge, Gateway, Capabilities]) {
  for (const name of Object.getOwnPropertyNames(part.prototype)) {
    if (name === 'constructor') continue;
    Object.defineProperty(HiOneDevice.prototype, name,
      Object.getOwnPropertyDescriptor(part.prototype, name));
  }
}

module.exports = HiOneDevice;
