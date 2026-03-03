'use strict';

const { Device } = require('homey');
const HoymilesHybrid = require('../../lib/HoymilesHybrid');

const POLL_INTERVAL_MS = 60_000;

class HiOneDevice extends Device {

  async onInit() {
    this.log('HiOne device initialising...');
    this._createHybrid();
    this._hybrid.probeLocal().catch(() => {});

    this.registerCapabilityListener('hoymiles_battery_mode', async (value) => {
      await this._hybrid.setBatteryMode(value);
    });

    this._pollInterval = this.homey.setInterval(() => this._poll(), POLL_INTERVAL_MS);
    await this._poll();
    this.log('HiOne device ready');
  }

  async onDeleted() {
    if (this._pollInterval) this.homey.clearInterval(this._pollInterval);
    this.log('HiOne device removed');
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('gateway_ip') || changedKeys.includes('cloud_api_url')) {
      this.log('Settings changed — reinitialising');
      this._createHybrid();
      this._hybrid.probeLocal().catch(() => {});
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

      // Connection source indicator
      if (this.hasCapability('hoymiles_connection_source')) {
        await this.setCapabilityValue('hoymiles_connection_source', data.source);
      }

      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this.error('Poll failed: ' + err.message);
      await this.setUnavailable(this.homey.__('errors.poll_failed'));
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
