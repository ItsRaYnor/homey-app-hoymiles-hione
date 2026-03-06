'use strict';

const HoymilesLocal = require('./HoymilesLocal');
const HoymilesApi   = require('./HoymilesApi');

const LOCAL_RETRY_AFTER_MS = 5 * 60 * 1000;
const LOCAL_FAIL_THRESHOLD = 3;

class HoymilesHybrid {
  constructor({ gatewayIp, email, password, stationId, log, error, baseUrl }) {
    this._email     = email;
    this._password  = password;
    this._stationId = stationId;
    this.log        = log;
    this.error      = error;
    this._local = gatewayIp ? new HoymilesLocal({ host: gatewayIp, log, error }) : null;
    this._cloud = new HoymilesApi({ log, error, baseUrl });
    this._localFails       = 0;
    this._localCooldownEnd = 0;
    this.connectionMode    = gatewayIp ? 'unknown' : 'cloud';
  }

  async getData() {
    if (this._localAvailable()) {
      try {
        const data = await this._getLocalData();
        this._localFails    = 0;
        this.connectionMode = 'local';
        return { ...data, source: 'local' };
      } catch (err) {
        this._localFails++;
        this.log('[Hybrid] Local failed (' + this._localFails + '/' + LOCAL_FAIL_THRESHOLD + '): ' + err.message);
        if (this._localFails >= LOCAL_FAIL_THRESHOLD) {
          this._localCooldownEnd = Date.now() + LOCAL_RETRY_AFTER_MS;
        }
      }
    }
    await this._cloud.ensureToken(this._email, this._password);
    const realData   = await this._cloud.getRealData(this._stationId);
    const energyData = await this._cloud.getEnergyData(this._stationId);
    this.connectionMode = 'cloud';
    return {
      pvPower: realData.pvPower, batteryPower: realData.batteryPower,
      batterySoc: realData.batterySoc, gridPower: realData.gridPower,
      loadPower: realData.loadPower, batteryMode: realData.batteryMode,
      dailyEnergy: energyData.dailyEnergy, totalEnergy: energyData.totalEnergy,
      source: 'cloud',
    };
  }

  async setBatteryMode(mode) {
    const modeNum = Number(mode);
    if (this._localAvailable()) {
      try {
        await this._local.setBatteryMode(modeNum);
        this.log('[Hybrid] setBatteryMode(' + modeNum + ') via LOCAL');
        return 'local';
      } catch (err) {
        this.log('[Hybrid] Local setBatteryMode failed: ' + err.message + ' - using cloud');
      }
    }
    await this._cloud.ensureToken(this._email, this._password);
    await this._cloud.setBatteryMode(this._stationId, modeNum);
    this.log('[Hybrid] setBatteryMode(' + modeNum + ') via CLOUD');
    return 'cloud';
  }

  async getGatewayInfo() {
    if (!this._local) return null;
    return this._local.getGatewayInfo();
  }

  async probeLocal() {
    if (!this._local) return false;
    const ok = await this._local.isReachable();
    this.log('[Hybrid] Local gateway: ' + (ok ? 'REACHABLE' : 'UNREACHABLE - using cloud'));
    if (ok) { this._localFails = 0; this._localCooldownEnd = 0; }
    return ok;
  }

  _localAvailable() {
    return this._local !== null && Date.now() >= this._localCooldownEnd;
  }

  async _getLocalData() {
    const [realData, storageData] = await Promise.all([
      this._local.getRealData(),
      this._local.getEnergyStorageData(),
    ]);
    return {
      pvPower:      realData.pvPower,
      batteryPower: storageData ? storageData.batteryPower : realData.batteryPower,
      batterySoc:   storageData ? storageData.batterySoc   : realData.batterySoc,
      gridPower:    realData.gridPower,
      loadPower:    realData.loadPower,
      batteryMode:  storageData ? storageData.batteryMode  : realData.batteryMode,
      dailyEnergy:  storageData ? storageData.dailyEnergy  : 0,
      totalEnergy:  storageData ? storageData.totalEnergy  : 0,
    };
  }
}

module.exports = HoymilesHybrid;