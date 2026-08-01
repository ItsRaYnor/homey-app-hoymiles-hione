'use strict';

const { Device } = require('homey');
const HoymilesHybrid = require('../../lib/HoymilesHybrid');
const { BATTERY_MODES } = require('../../lib/HoymilesApi');

// Battery mode / reserve / max-power use a slow async cloud command (a job
// read that can take ~30s), so they refresh on their own slower cadence —
// independent of the live poll interval (~60s). An in-app change still
// refreshes immediately (see the battery-mode capability listener).
// Heavy cloud settings (mode / reserve / max-power / EPS) — keep light live
// data on the normal poll interval (~60s) and refresh this slower.
const SETTINGS_REFRESH_MS = 5 * 60_000; // 5 min

// Selecting the battery mode in the app fires for every value scrolled past.
// Wait until the choice settles before writing it to the cloud, so scrolling
// through the picker doesn't apply each intermediate mode.
const MODE_APPLY_DELAY_MS = 2_500;

// The cloud rejects a new mode write until the previous one has settled
// (~10s), so enforce a minimum gap between mode writes to avoid API errors.
const MODE_MIN_INTERVAL_MS = 10_000;

// The local power limit is persisted to the inverter's EEPROM on every write.
// Cap automated writes per day and skip no-op writes to limit chip wear.
const POWER_LIMIT_MAX_WRITES_PER_DAY = 10;

// Capabilities added after v1.0.x — added to existing devices on init
// Percent sliders are stored as plain 0–100 (matching the API and the Insights
// graphs). They deliberately have no units "%" in the manifest, because Homey
// renders a units-"%" capability as a 0–1 fraction ×100 — which made the
// Insights graph read 100× too small. The "%" is shown in the title instead.
const PERCENT_SLIDERS = [
  'hoymiles_reserve_soc',
  'hoymiles_max_soc',
  'hoymiles_max_charge_power',
  'hoymiles_max_discharge_power',
];

// Values that always come from the cloud, even when the live data is read
// locally over Modbus — so they lag by minutes. Their titles get a small cloud
// marker appended while a local connection is active, making it obvious per
// tile which readings are instant and which are not. Everything else (battery
// power/SoC/voltage/current, grid, PV, house load) comes straight off the stick.
const CLOUD_SOURCED_CAPABILITIES = [
  'hoymiles_battery_mode',
  'meter_power.charged',
  'meter_power.discharged',
  'hoymiles_daily_energy',
  'hoymiles_monthly_energy',
  'hoymiles_yearly_energy',
  'hoymiles_total_energy',
  'hoymiles_co2_reduction',
  'hoymiles_profit_today',
  'hoymiles_profit_total',
  'hoymiles_reserve_soc',
  'hoymiles_max_soc',
  'hoymiles_max_charge_power',
  'hoymiles_max_discharge_power',
  'hoymiles_meter_power',
];
const CLOUD_MARKER = ' ☁';

const NEW_CAPABILITIES = [
  'hoymiles_battery_flow',
  'measure_voltage',
  'measure_current',
  'meter_power.charged',
  'meter_power.discharged',
  'hoymiles_reserve_soc',
  'hoymiles_max_soc',
  'hoymiles_max_charge_power',
  'hoymiles_max_discharge_power',
  'hoymiles_meter_power',
  'hoymiles_monthly_energy',
  'hoymiles_yearly_energy',
  'hoymiles_co2_reduction',
  'hoymiles_profit_today',
  'hoymiles_profit_total',
  'hoymiles_connection_source',
];

// Capabilities replaced by a better equivalent — removed from existing devices.
// The device is now a Homey "home battery": measure_power = battery power and
// charged/discharged energy is tracked via meter_power.charged/.discharged.
const REMOVED_CAPABILITIES = [
  'hoymiles_battery_power',
  'measure_power.battery',
  'hoymiles_max_power',           // → split into max_charge_power / max_discharge_power
  'meter_power',                  // base PV total — not used for a battery device
  'hoymiles_battery_in_energy',   // → meter_power.charged
  'hoymiles_battery_out_energy',  // → meter_power.discharged
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

    await this._migrateCapabilities();
    this._createHybrid();
    this._hybrid.probeLocal()
      .catch(() => {})
      .finally(() => this._fetchGatewayInfo());

    this.registerCapabilityListener('hoymiles_battery_mode', async (value) => {
      // Debounce: the picker fires for every mode scrolled past. Only apply the
      // value the user settles on. Also enforce a ~10s gap between writes — the
      // cloud rejects a new mode while the previous one is still settling — so a
      // quick second choice waits out the cooldown instead of erroring.
      this._pendingMode = value;
      if (this._modeChangeTimer) this.homey.clearTimeout(this._modeChangeTimer);
      const cooldownLeft = this._lastModeApplyAt + MODE_MIN_INTERVAL_MS - Date.now();
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
    this.registerCapabilityListener('hoymiles_reserve_soc', async (value) => {
      try {
        await this._hybrid.setReserveSoc(value);
      } catch (err) {
        this.error('Reserve SOC change failed: ' + err.message);
      }
    });

    this.registerCapabilityListener('hoymiles_max_charge_power', async (value) => {
      try {
        await this._hybrid.setMaxChargePower(value);
      } catch (err) {
        this.error('Max charge power change failed: ' + err.message);
      }
    });

    this.registerCapabilityListener('hoymiles_max_discharge_power', async (value) => {
      try {
        await this._hybrid.setMaxDischargePower(value);
      } catch (err) {
        this.error('Max discharge power change failed: ' + err.message);
      }
    });

    this.registerCapabilityListener('hoymiles_max_soc', async (value) => {
      try {
        await this._hybrid.setMaxSoc(value);
      } catch (err) {
        this.error('Max SOC change failed: ' + err.message);
      }
    });

    this.registerCapabilityListener('hoymiles_meter_power', async (value) => {
      try {
        await this._hybrid.setGridLimit(value);
      } catch (err) {
        this.error('Grid limit change failed: ' + err.message);
      }
    });

    this._startPolling();
    await this._poll();
    this.log('HiOne device ready');
  }

  async onDeleted() {
    this._stopPolling();
    this._clearFollowupPolls();
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
    if (this._cloudMarkersApplied === mixed) return;
    this._cloudMarkersApplied = mixed;

    const lang = this.homey.i18n.getLanguage();
    const pick = (title) => (title && (title[lang] || title.en)) || null;
    const driverOpts = (this.driver.manifest && this.driver.manifest.capabilitiesOptions) || {};
    const appCaps    = (this.homey.manifest && this.homey.manifest.capabilities) || {};

    for (const capability of CLOUD_SOURCED_CAPABILITIES) {
      if (!this.hasCapability(capability)) continue;
      try {
        // Keep whatever options are already set (slider ranges, enum values);
        // only the title changes.
        let options = {};
        try { options = this.getCapabilityOptions(capability) || {}; } catch (_) { /* none set yet */ }

        const base = pick(driverOpts[capability] && driverOpts[capability].title)
          || pick(appCaps[capability.split('.')[0]] && appCaps[capability.split('.')[0]].title)
          || (options.title || '').replace(CLOUD_MARKER, '');
        if (!base) continue;

        const title = mixed ? base + CLOUD_MARKER : base;
        if (options.title === title) continue;
        await this.setCapabilityOptions(capability, { ...options, title });
      } catch (err) {
        this.log(`Could not label ${capability}: ${err.message}`);
      }
    }
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
      this.error('Mode change rejected by cloud: ' + err.message);
      // Reconcile the tile with the actual cloud mode so it doesn't show a
      // value that was never applied.
      this._refreshBatterySettings().catch(() => {});
      return;
    }
    await this._refreshBatterySettings().catch(() => {});
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
    if (changedKeys.includes('gateway_ip') || changedKeys.includes('cloud_api_url')
      || changedKeys.includes('station_id')) {
      this.log('Connection settings changed — reinitialising');
      this._createHybrid();
      this._hybrid.probeLocal()
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

    // Force the new 0–100 slider options on existing devices, and clear the
    // cached units "%" — Homey rendered a units-"%" capability as a 0–1 fraction
    // ×100, which made the Insights graph read 100× too small. Now stored as a
    // plain 0–100 percent (the "%" lives in the title).
    for (const capability of PERCENT_SLIDERS) {
      if (this.hasCapability(capability)) {
        try {
          await this.setCapabilityOptions(capability, {
            min: 0, max: 100, step: 1, decimals: 0, units: '',
          });
        } catch (err) {
          this.error('Could not update options for ' + capability + ': ' + err.message);
        }
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

  async _setCapabilitySafe(capability, value) {
    if (value === null || value === undefined) return;
    if (!this.hasCapability(capability)) return;
    try {
      await this.setCapabilityValue(capability, value);
    } catch (err) {
      this.error('setCapabilityValue(' + capability + ') failed: ' + err.message);
    }
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
      await this._setCapabilitySafe('hoymiles_pv_power',            data.pvPower);
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
      await this._applyCloudMarkers(data.source);

      // Local data carries the active mode; cloud mode comes from settings
      if (data.batteryMode !== null && data.batteryMode !== undefined) {
        await this._updateBatteryMode(data.batteryMode);
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
        await this._updateBatteryMode(settings.mode);
        await this._setCapabilitySafe('hoymiles_reserve_soc',          settings.reserveSoc);
        await this._setCapabilitySafe('hoymiles_max_charge_power',     settings.maxChargePower);
        await this._setCapabilitySafe('hoymiles_max_discharge_power',  settings.maxDischargePower);
        await this._setCapabilitySafe('hoymiles_max_soc',              settings.maxSoc);
        await this._setCapabilitySafe('hoymiles_meter_power',          settings.meterPower);
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

  async _updateBatteryMode(mode) {
    await this._setCapabilitySafe('hoymiles_battery_mode', mode);

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

  _createHybrid() {
    const store     = this.getStore();
    const settings  = this.getSettings();
    // Device-specific IP wins; fall back to the app-wide saved IP
    const gatewayIp = (settings && settings.gateway_ip)
      || store.gatewayIp
      || this.homey.settings.get('saved_gateway_ip')
      || null;

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
  }
}

module.exports = HiOneDevice;
