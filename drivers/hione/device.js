'use strict';

const { Device } = require('homey');
const HoymilesHybrid = require('../../lib/HoymilesHybrid');
const { BATTERY_MODES } = require('../../lib/HoymilesApi');

// Battery settings use a slow async cloud command — refresh every Nth poll
const SETTINGS_POLL_EVERY = 5;

// Capabilities added after v1.0.x — added to existing devices on init
const NEW_CAPABILITIES = [
  'hoymiles_reserve_soc',
  'hoymiles_monthly_energy',
  'hoymiles_yearly_energy',
  'hoymiles_battery_in_energy',
  'hoymiles_battery_out_energy',
  'hoymiles_co2_reduction',
  'hoymiles_profit_today',
  'hoymiles_profit_total',
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

    this.registerCapabilityListener('hoymiles_reserve_soc', async (value) => {
      await this._hybrid.setReserveSoc(value);
      this._refreshBatterySettings().catch(() => {});
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
    try {
      const data = await this._hybrid.getData();

      await this._setCapabilitySafe('measure_power',                data.pvPower);
      await this._setCapabilitySafe('hoymiles_pv_power',            data.pvPower);
      await this._setCapabilitySafe('hoymiles_battery_power',       data.batteryPower);
      await this._setCapabilitySafe('measure_battery',              data.batterySoc);
      await this._setCapabilitySafe('hoymiles_grid_power',          data.gridPower);
      await this._setCapabilitySafe('hoymiles_load_power',          data.loadPower);
      await this._setCapabilitySafe('hoymiles_daily_energy',        data.dailyEnergy);
      await this._setCapabilitySafe('hoymiles_monthly_energy',      data.monthlyEnergy);
      await this._setCapabilitySafe('hoymiles_yearly_energy',       data.yearlyEnergy);
      await this._setCapabilitySafe('hoymiles_total_energy',        data.totalEnergy);
      await this._setCapabilitySafe('meter_power',                  data.totalEnergy);
      await this._setCapabilitySafe('hoymiles_battery_in_energy',   data.batteryInEnergy);
      await this._setCapabilitySafe('hoymiles_battery_out_energy',  data.batteryOutEnergy);
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
      await this._setCapabilitySafe('hoymiles_reserve_soc', settings.reserveSoc);
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

  async setPowerLimit(limitPercent) {
    await this._hybrid.setPowerLimit(limitPercent);
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
      localPort: this.homey.settings.get('local_port') || undefined,
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
