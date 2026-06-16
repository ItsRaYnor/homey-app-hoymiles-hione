'use strict';

const { Device } = require('homey');
const HoymilesHybrid = require('../../lib/HoymilesHybrid');
const { BATTERY_MODES } = require('../../lib/HoymilesApi');

// Battery settings use a slow async cloud command — refresh every Nth poll
const SETTINGS_POLL_EVERY = 5;

// The local power limit is persisted to the inverter's EEPROM on every write.
// Cap automated writes per day and skip no-op writes to limit chip wear.
const POWER_LIMIT_MAX_WRITES_PER_DAY = 10;

// Capabilities added after v1.0.x — added to existing devices on init
// Homey % sliders store 0–1; API/Flows use 0–100
// Homey stores capabilities with units "%" internally as a 0–1 fraction
// (50% = 0.5) and renders them ×100. The API works in 0–100, so these are
// converted: ÷100 when writing to the capability, ×100 when reading it back.
const PERCENT_SLIDERS = [
  'hoymiles_reserve_soc',
  'hoymiles_max_soc',
  'hoymiles_max_charge_power',
  'hoymiles_max_discharge_power',
];
const PCT_CAPABILITIES = new Set(PERCENT_SLIDERS);

const NEW_CAPABILITIES = [
  'hoymiles_battery_flow',
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
    this._pollCount = 0;

    await this._migrateCapabilities();
    this._createHybrid();
    this._hybrid.probeLocal().then(() => this._fetchGatewayInfo()).catch(() => {});

    this.registerCapabilityListener('hoymiles_battery_mode', async (value) => {
      await this._hybrid.setBatteryMode(value);
      this._refreshBatterySettings().catch(() => {});
    });

    // NOTE: slider listeners deliberately do NOT call _refreshBatterySettings()
    // afterwards. The cloud write is async and re-reading immediately returns
    // the stale (pre-write) value, which setCapabilityValue then writes back to
    // the slider — resetting it to 0 while the user is still dragging. The
    // periodic poll reconciles the slider with the cloud a bit later instead.
    this.registerCapabilityListener('hoymiles_reserve_soc', async (value) => {
      await this._hybrid.setReserveSoc(this._capToPercent(value));
    });

    this.registerCapabilityListener('hoymiles_max_charge_power', async (value) => {
      await this._hybrid.setMaxChargePower(this._capToPercent(value));
    });

    this.registerCapabilityListener('hoymiles_max_discharge_power', async (value) => {
      await this._hybrid.setMaxDischargePower(this._capToPercent(value));
    });

    this.registerCapabilityListener('hoymiles_max_soc', async (value) => {
      await this._hybrid.setMaxSoc(this._capToPercent(value));
    });

    this.registerCapabilityListener('hoymiles_meter_power', async (value) => {
      await this._hybrid.setGridLimit(value);
    });

    this._startPolling();
    await this._poll();
    this.log('HiOne device ready');
  }

  async onDeleted() {
    this._stopPolling();
    this.log('HiOne device removed');
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('gateway_ip') || changedKeys.includes('cloud_api_url')) {
      this.log('Connection settings changed — reinitialising');
      this._createHybrid();
      this._hybrid.probeLocal().catch(() => {});
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

    // Force the correct slider options on existing devices. Homey treats
    // units "%" capabilities as a 0–1 fraction internally, so these must be
    // min 0 / max 1 (an earlier build wrongly set max 100, which rendered
    // values ×100 as e.g. 3000%).
    for (const capability of PERCENT_SLIDERS) {
      if (this.hasCapability(capability)) {
        try {
          await this.setCapabilityOptions(capability, {
            min: 0, max: 1, step: 0.01, decimals: 2, units: '%',
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
    this._pollInterval = this.homey.setInterval(() => this._poll(), ms);
    this.log('Polling every ' + (ms / 1000) + 's');
  }

  _stopPolling() {
    if (this._pollInterval) {
      this.homey.clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  _percentToCap(percent) {
    if (percent === null || percent === undefined) return null;
    const n = Number(percent);
    if (isNaN(n)) return null;
    return Math.round(n) / 100;
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

  // Slider passes 0–1; Flow cards pass 0–100
  _capToPercent(value) {
    const n = Number(value);
    if (isNaN(n)) throw new Error('Invalid percentage value: ' + value);
    return n <= 1 ? Math.round(n * 100) : Math.round(n);
  }

  async _setCapabilitySafe(capability, value) {
    if (value === null || value === undefined) return;
    if (!this.hasCapability(capability)) return;
    const capValue = PCT_CAPABILITIES.has(capability) ? this._percentToCap(value) : value;
    try {
      await this.setCapabilityValue(capability, capValue);
      if (PCT_CAPABILITIES.has(capability)) {
        this.log(`[cap] set ${capability} = ${capValue} (${this._capToPercent(capValue)}%) → readback ${this.getCapabilityValue(capability)}`);
      }
    } catch (err) {
      this.error('setCapabilityValue(' + capability + ') failed: ' + err.message);
    }
  }

  async _poll() {
    try {
      const data = await this._hybrid.getData();

      await this._setCapabilitySafe('measure_power',                data.batteryPower);
      await this._setCapabilitySafe('hoymiles_battery_flow',        this._batteryFlowText(data.batteryPower));
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

      // Local data carries the active mode; cloud mode comes from settings
      if (data.batteryMode !== null && data.batteryMode !== undefined) {
        await this._updateBatteryMode(data.batteryMode);
      }

      this._pollCount++;
      if (this._pollCount % SETTINGS_POLL_EVERY === 1) {
        this._refreshBatterySettings().catch(() => {});
      }

      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this.error('Poll failed: ' + err.message);
      await this.setUnavailable(this.homey.__('errors.poll_failed'));
    }
  }

  async _refreshBatterySettings() {
    const settings = await this._hybrid.getBatterySettings();
    if (settings) {
      await this._updateBatteryMode(settings.mode);
      await this._setCapabilitySafe('hoymiles_reserve_soc',          settings.reserveSoc);
      await this._setCapabilitySafe('hoymiles_max_charge_power',     settings.maxChargePower);
      await this._setCapabilitySafe('hoymiles_max_discharge_power',  settings.maxDischargePower);
      await this._setCapabilitySafe('hoymiles_max_soc',             settings.maxSoc);
      await this._setCapabilitySafe('hoymiles_meter_power', settings.meterPower);
    }

    const profit = await this._hybrid.getEpsProfit();
    if (profit) {
      await this._setCapabilitySafe('hoymiles_profit_today', profit.todayProfit);
      await this._setCapabilitySafe('hoymiles_profit_total', profit.totalProfit);
    }
  }

  // Called by the driver's flow action cards
  async setPeakShaving(settings) {
    await this._hybrid.setPeakShaving(settings);
    this._refreshBatterySettings().catch(() => {});
  }

  async setRelayEnabled(enabled) {
    await this._hybrid.setRelayEnabled(enabled);
  }

  async setMaxPower(percent) {
    await this._hybrid.setMaxPower(percent);
    this._refreshBatterySettings().catch(() => {});
  }

  async setMaxSoc(percent) {
    await this._hybrid.setMaxSoc(percent);
    this._refreshBatterySettings().catch(() => {});
  }

  async setGridLimit(watts) {
    await this._hybrid.setGridLimit(watts);
    this._refreshBatterySettings().catch(() => {});
  }

  async setTouPeriod(period) {
    await this._hybrid.setTouPeriod(period);
    this._refreshBatterySettings().catch(() => {});
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
      if (Object.keys(updates).length > 0) {
        await this.setSettings(updates);
        this.log('Gateway info updated: ' + JSON.stringify(updates));
      }
    } catch (err) {
      this.log('Could not fetch gateway info: ' + err.message);
    }
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

    this._hybrid = new HoymilesHybrid({
      gatewayIp,
      localPort:     this.homey.settings.get('local_port') || undefined,
      localProtocol: store.localProtocol || this.homey.settings.get('local_protocol') || 'auto',
      modbusUnitId:  this.homey.settings.get('modbus_unit_id') || undefined,
      email:     store.email,
      password:  store.password,
      stationId: this.getData().stationId,
      baseUrl,
      log:       this.log.bind(this),
      error:     this.error.bind(this),
    });
  }
}

module.exports = HiOneDevice;
