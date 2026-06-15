'use strict';

const HoymilesLocal  = require('./HoymilesLocal');
const HoymilesModbus = require('./HoymilesModbus');
const HoymilesApi    = require('./HoymilesApi');

const LOCAL_RETRY_AFTER_MS = 5 * 60 * 1000;
const LOCAL_FAIL_THRESHOLD = 3;

// Local (BMSWorkingMode) and cloud modes share the same 1-based numbering
// 1–8. Only modes without schedule payloads can be set locally; the rest
// (Economy, Max Power variants, Peak Shaving, ToU) go through the cloud.
const { LOCAL_SETTABLE_MODES } = require('./HoymilesLocal');

class HoymilesHybrid {
  constructor({ gatewayIp, localPort, localProtocol, modbusUnitId,
    email, password, stationId, log, error, baseUrl }) {
    this._email     = email;
    this._password  = password;
    this._stationId = stationId;
    this.log        = log;
    this.error      = error;
    this._protocol  = localProtocol || 'auto'; // 'auto' | 'native' | 'modbus'

    // Native hoymiles-wifi protocol (TCP 10081) — older DTU/WLite sticks
    this._local = gatewayIp
      ? new HoymilesLocal({ host: gatewayIp, port: localPort, log, error })
      : null;

    // Modbus TCP (port 502) — DTS-G3 / DTU-Pro with "Remote Control" enabled
    this._modbus = (gatewayIp && this._protocol !== 'native')
      ? new HoymilesModbus({
          host:   gatewayIp,
          port:   (this._protocol === 'modbus' || !localPort) ? 502 : undefined,
          unitId: modbusUnitId,
          log, error,
        })
      : null;

    this._cloud = new HoymilesApi({ log, error, baseUrl });
    this._localFails       = 0;
    this._localCooldownEnd = 0;
    this.connectionMode    = gatewayIp ? 'unknown' : 'cloud';
  }

  /** Modbus is the active local transport when explicitly selected, or in
   *  'auto' mode once we've confirmed the stick answers on 502. */
  _modbusActive() {
    return this._modbus !== null && (this._protocol === 'modbus' || this._modbusConfirmed === true);
  }

  _cloudAvailable() {
    return Boolean(this._email && this._password && this._stationId);
  }

  async getData() {
    // Modbus transport: read live data when the battery register map is
    // calibrated; otherwise fall through to cloud for data (control still
    // goes over Modbus). Returns null until BATTERY_REGISTERS is filled in.
    if (this._modbusActive()) {
      try {
        const md = await this._modbus.getData();
        if (md) {
          this.connectionMode = 'local';
          await this._mergeCloudEnergy(md);
          return { ...md, source: 'local' };
        }
      } catch (err) {
        this.log('[Hybrid] Modbus data read failed: ' + err.message);
      }
      // No calibrated registers yet → use cloud for data below
    } else if (this._localAvailable()) {
      try {
        const data = await this._getLocalData();
        this._localFails    = 0;
        this.connectionMode = 'local';
        await this._mergeCloudEnergy(data);
        return { ...data, source: 'local' };
      } catch (err) {
        this._localFails++;
        this.log('[Hybrid] Local failed (' + this._localFails + '/' + LOCAL_FAIL_THRESHOLD + '): ' + err.message);
        if (this._localFails >= LOCAL_FAIL_THRESHOLD) {
          this._localCooldownEnd = Date.now() + LOCAL_RETRY_AFTER_MS;
        }
        if (!this._cloudAvailable()) throw err;
      }
    }
    if (!this._cloudAvailable()) throw new Error('No cloud credentials and local gateway unreachable');

    await this._cloud.ensureToken(this._email, this._password);
    const realData = await this._cloud.getRealData(this._stationId);
    this.connectionMode = 'cloud';
    return { ...realData, source: 'cloud' };
  }

  /**
   * Local data has no daily/monthly/yearly counters — top them up from the
   * cloud every Nth poll when credentials are available.
   */
  async _mergeCloudEnergy(data) {
    if (!this._cloudAvailable()) return;
    this._cloudTopUpCount = (this._cloudTopUpCount || 0) + 1;
    if (this._cloudTopUpCount % 5 !== 1) return;
    try {
      await this._cloud.ensureToken(this._email, this._password);
      const cloud = await this._cloud.getRealData(this._stationId);
      for (const key of ['dailyEnergy', 'monthlyEnergy', 'yearlyEnergy',
        'totalEnergy', 'co2Reduction', 'batteryInEnergy', 'batteryOutEnergy']) {
        if (data[key] === null || data[key] === undefined) data[key] = cloud[key];
      }
    } catch (err) {
      this.log('[Hybrid] Cloud energy top-up failed: ' + err.message);
    }
  }

  /**
   * Battery settings (active mode + reserve SOC) are cloud-only.
   * Returns null when running local-only or when the read fails.
   */
  async getBatterySettings() {
    if (!this._cloudAvailable()) return null;
    try {
      await this._cloud.ensureToken(this._email, this._password);
      return await this._cloud.getBatterySettings(this._stationId);
    } catch (err) {
      this.log('[Hybrid] getBatterySettings failed: ' + err.message);
      return null;
    }
  }

  async setBatteryMode(mode) {
    const modeNum = Number(mode);
    if (this._localAvailable() && LOCAL_SETTABLE_MODES.includes(modeNum)) {
      try {
        await this._local.setBatteryMode(modeNum);
        this.log('[Hybrid] setBatteryMode(' + modeNum + ') via LOCAL');
        return 'local';
      } catch (err) {
        this.log('[Hybrid] Local setBatteryMode failed: ' + err.message + ' - using cloud');
      }
    }
    if (!this._cloudAvailable()) throw new Error('Setting this mode requires cloud credentials');
    await this._cloud.ensureToken(this._email, this._password);
    await this._cloud.setBatteryMode(this._stationId, modeNum);
    this.log('[Hybrid] setBatteryMode(' + modeNum + ') via CLOUD');
    return 'cloud';
  }

  /**
   * Reserve SOC can only be written through the cloud API.
   */
  async setReserveSoc(reserveSoc) {
    if (!this._cloudAvailable()) throw new Error('Setting reserve SOC requires cloud credentials');
    await this._cloud.ensureToken(this._email, this._password);
    await this._cloud.setReserveSoc(this._stationId, reserveSoc);
    return 'cloud';
  }

  /**
   * Peak Shaving parameters can only be written through the cloud API.
   */
  async setPeakShaving(settings) {
    if (!this._cloudAvailable()) throw new Error('Peak Shaving settings require cloud credentials');
    await this._cloud.ensureToken(this._email, this._password);
    await this._cloud.setPeakShaving(this._stationId, settings);
    return 'cloud';
  }

  /**
   * Max charge/discharge power (%) — cloud-only.
   */
  async setMaxPower(percent) {
    if (!this._cloudAvailable()) throw new Error('Setting max power requires cloud credentials');
    await this._cloud.ensureToken(this._email, this._password);
    await this._cloud.setMaxPower(this._stationId, percent);
    return 'cloud';
  }

  /**
   * Max SOC (%) — cloud-only.
   */
  async setMaxSoc(percent) {
    if (!this._cloudAvailable()) throw new Error('Setting max SOC requires cloud credentials');
    await this._cloud.ensureToken(this._email, this._password);
    await this._cloud.setMaxSoc(this._stationId, percent);
    return 'cloud';
  }

  /**
   * Grid power limit (W, Peak Shaving) — cloud-only.
   */
  async setGridLimit(watts) {
    if (!this._cloudAvailable()) throw new Error('Setting the grid limit requires cloud credentials');
    await this._cloud.ensureToken(this._email, this._password);
    await this._cloud.setGridLimit(this._stationId, watts);
    return 'cloud';
  }

  /**
   * Time-of-Use charge/discharge period — cloud-only.
   */
  async setTouPeriod(period) {
    if (!this._cloudAvailable()) throw new Error('Setting a Time of Use period requires cloud credentials');
    await this._cloud.ensureToken(this._email, this._password);
    await this._cloud.setTouPeriod(this._stationId, period);
    return 'cloud';
  }

  /**
   * Relay / dry contact control is cloud-only.
   */
  async setRelayEnabled(enabled) {
    if (!this._cloudAvailable()) throw new Error('Relay control requires cloud credentials');
    await this._cloud.ensureToken(this._email, this._password);
    await this._cloud.setRelayEnabled(this._stationId, enabled);
    return 'cloud';
  }

  /**
   * EPS savings counters are cloud-only. Returns null when unavailable.
   */
  async getEpsProfit() {
    if (!this._cloudAvailable()) return null;
    try {
      await this._cloud.ensureToken(this._email, this._password);
      return await this._cloud.getEpsProfit(this._stationId);
    } catch (err) {
      this.log('[Hybrid] getEpsProfit failed: ' + err.message);
      return null;
    }
  }

  /**
   * Output power limit — local only. Uses Modbus (register 0xC001) when the
   * Modbus transport is active, otherwise the native protocol.
   */
  async setPowerLimit(limitPercent) {
    if (this._modbusActive()) {
      await this._modbus.setPowerLimit(limitPercent);
      return 'modbus';
    }
    if (!this._local) throw new Error('Power limit requires a local connection (set the gateway IP)');
    await this._local.setPowerLimit(limitPercent);
    return 'local';
  }

  /**
   * Inverter on/off. Modbus controls all inverters at once (register 0xC000)
   * and ignores the serial; the native protocol targets a serial number.
   */
  async setInverterState(serial, on) {
    if (this._modbusActive()) {
      await this._modbus.setInverterState(on);
      return 'modbus';
    }
    if (!this._local) throw new Error('Inverter on/off requires a local connection (set the gateway IP)');
    await this._local.setInverterState(serial, on);
    return 'local';
  }

  /**
   * Diagnostic: scan a Modbus register range to discover the HiOne hybrid
   * battery registers. Returns a { '0xXXXX': value } map.
   */
  async scanModbus(start, count, opts = {}) {
    if (!this._modbus) throw new Error('No gateway IP configured for Modbus');
    return this._modbus.scan(start, count, opts);
  }

  async getGatewayInfo() {
    // Gateway info is only available over the native protocol; a Modbus-only
    // stick has no equivalent, so don't waste a refused 10081 connection on it.
    if (!this._local || this._protocol === 'modbus') return null;
    return this._local.getGatewayInfo();
  }

  async probeLocal() {
    // Modbus path: confirm the stick answers on 502
    if (this._modbus && this._protocol !== 'native') {
      const ok = await this._modbus.isReachable();
      this._modbusConfirmed = ok;
      this.log('[Hybrid] Modbus (502): ' + (ok ? 'REACHABLE' : 'no answer'));
      if (ok) { this._localFails = 0; this._localCooldownEnd = 0; return true; }
    }
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
    // ES data is the primary local source for HiOne/hybrid systems
    const es = await this._local.getEnergyStorageData();
    if (es) {
      return {
        ...es,
        monthlyEnergy: null, yearlyEnergy: null, co2Reduction: null,
      };
    }
    // Fallback: generic micro-inverter style real data
    const realData = await this._local.getRealData();
    return {
      ...realData,
      dailyEnergy: null, totalEnergy: null,
      monthlyEnergy: null, yearlyEnergy: null,
      batteryInEnergy: null, batteryOutEnergy: null, co2Reduction: null,
    };
  }
}

module.exports = HoymilesHybrid;
