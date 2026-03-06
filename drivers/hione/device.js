'use strict';

const { Device } = require('homey');
const HoymilesHybrid = require('../../lib/HoymilesHybrid');
const { BATTERY_MODES } = require('../../lib/HoymilesApi');

const DEFAULT_POLL_MS = 60_000;

class HiOneDevice extends Device {

  async onInit() {
    this.log('HiOne device initialising...');
    this._prevBatteryMode = null;
    this._createHybrid();
    this._hybrid.probeLocal().then(() => this._fetchGatewayInfo()).catch(() => {});

    this.registerCapabilityListener('hoymiles_battery_mode', async (value) => {
      await this._hybrid.setBatteryMode(value);
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

  async _poll() {
    try {
      const data = await this._hybrid.getData();

      await this.setCapabilityValue('measure_power',          data.pvPower);
      await this.setCapabilityValue('hoymiles_pv_power',      data.pvPower);
      await this.setCapabilityValue('hoymiles_battery_power', data.batteryPower);
      await this.setCapabilityValue('measure_battery',        data.batterySoc);
      await this.setCapabilityValue('hoymiles_grid_power',    data.gridPower);
      await this.setCapabilityValue('hoymiles_load_power',    data.loadPower);
      await this.setCapabilityValue('hoymiles_battery_mode',  data.batteryMode);
      await this.setCapabilityValue('hoymiles_daily_energy',  data.dailyEnergy);
      await this.setCapabilityValue('hoymiles_total_energy',  data.totalEnergy);
      await this.setCapabilityValue('meter_power',            data.totalEnergy);

      if (this.hasCapability('hoymiles_connection_source')) {
        await this.setCapabilityValue('hoymiles_connection_source', data.source);
      }

      // Trigger flow when battery mode changes
      if (this._prevBatteryMode !== null && data.batteryMode !== this._prevBatteryMode) {
        const modeName = BATTERY_MODES[Number(data.batteryMode)] || data.batteryMode;
        this.homey.flow.getDeviceTriggerCard('battery_mode_changed')
          .trigger(this, { mode: modeName })
          .catch(err => this.error('Trigger failed: ' + err.message));
      }
      this._prevBatteryMode = data.batteryMode;

      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this.error('Poll failed: ' + err.message);
      await this.setUnavailable(this.homey.__('errors.poll_failed'));
    }
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
    const gatewayIp = (settings && settings.gateway_ip) || store.gatewayIp || null;

    const baseUrl = (settings && settings.cloud_api_url)
      || this.homey.settings.get('cloud_api_url')
      || undefined;

    this._hybrid = new HoymilesHybrid({
      gatewayIp,
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
