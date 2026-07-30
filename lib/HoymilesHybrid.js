'use strict';

const HoymilesLocal  = require('./HoymilesLocal');
const HoymilesModbus = require('./HoymilesModbus');
const HoymilesApi    = require('./HoymilesApi');

const LOCAL_RETRY_AFTER_MS = 5 * 60 * 1000;
const LOCAL_FAIL_THRESHOLD = 3;
// Hard native failures (ECONNREFUSED / unreachable) mean the stick does not
// speak TCP 10081 — do not keep retrying every few minutes.
const LOCAL_HARD_FAIL_COOLDOWN_MS = 60 * 60 * 1000;

// Local (BMSWorkingMode) and cloud modes share the same 1-based numbering.
// Only modes without schedule/cloud-managed payloads can be set locally; the rest
// (Economy, Max Power variants, Peak Shaving, ToU) go through the cloud.
const { LOCAL_SETTABLE_MODES } = require('./HoymilesLocal');

class HoymilesHybrid {
  constructor({ gatewayIp, localPort, localProtocol, modbusUnitId,
    email, password, stationId, log, error, baseUrl, cloudApi }) {
    this._email     = email;
    this._password  = password;
    this._stationId = stationId;
    this.log        = log;
    this.error      = error;
    this._protocol  = localProtocol || 'modbus'; // 'modbus' | 'auto' | 'native'

    // Native hoymiles-wifi protocol (TCP 10081) — older DTU/WLite sticks.
    // Skip entirely when pinned to Modbus: DTS-WL-G3 often refuses 10081 and
    // retries only create log noise and wasted sockets.
    this._local = (gatewayIp && this._protocol !== 'modbus')
      ? new HoymilesLocal({ host: gatewayIp, port: localPort, log, error })
      : null;

    // Modbus TCP (port 502) — DTS-G3 / DTU-Pro; a DTS-WL-G3 answers on unit id 1
    // out of the box, other sticks may need RS485 "Remote Control" configured
    this._modbus = (gatewayIp && this._protocol !== 'native')
      ? new HoymilesModbus({
          host:   gatewayIp,
          port:   (this._protocol === 'modbus' || this._protocol === 'auto' || !localPort) ? 502 : localPort,
          unitId: modbusUnitId,
          log, error,
        })
      : null;

    // Reuse the app-wide client so devices share tokens, auth backoff and the
    // in-flight login. Keep a separate client only for a device-specific URL.
    this._cloud = cloudApi && (!baseUrl || cloudApi._baseUrl === baseUrl)
      ? cloudApi
      : new HoymilesApi({ log, error, baseUrl });
    this._localFails       = 0;
    this._localCooldownEnd = 0;
    this.connectionMode    = gatewayIp ? 'unknown' : 'cloud';
  }

  /** Modbus is active when selected, in auto mode, or after a confirmed answer on 502. */
  _modbusActive() {
    return this._modbus !== null && (
      this._protocol === 'modbus'
      || this._protocol === 'auto'
      || this._modbusConfirmed === true
    );
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
          // Modbus provides battery SoC/power/voltage and derived current.
          // PV/grid/load and energy totals are topped up from cloud, so say so
          // explicitly rather than claiming the whole reading is local.
          return { ...md, source: this._cloudAvailable() ? 'modbus_cloud' : 'modbus' };
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
        return { ...data, source: 'native' };
      } catch (err) {
        this._localFails++;
        this.log('[Hybrid] Local failed (' + this._localFails + '/' + LOCAL_FAIL_THRESHOLD + '): ' + err.message);
        if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|Timeout connecting/i.test(err.message)) {
          this._localCooldownEnd = Date.now() + LOCAL_HARD_FAIL_COOLDOWN_MS;
          this.log('[Hybrid] Native 10081 unavailable — pausing retries for 60 min');
        } else if (this._localFails >= LOCAL_FAIL_THRESHOLD) {
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
   * Top up fields the active local source doesn't provide. Existing local
   * values always win; cloud is only a fallback for null/undefined fields.
   */
  async _mergeCloudEnergy(data) {
    if (!this._cloudAvailable()) return;
    this._cloudTopUpCount = (this._cloudTopUpCount || 0) + 1;
    if (this._cloudTopUpCount % 5 !== 1) return;
    try {
      await this._cloud.ensureToken(this._email, this._password);
      const cloud = await this._cloud.getRealData(this._stationId);
      for (const key of ['dailyEnergy', 'monthlyEnergy', 'yearlyEnergy',
        'totalEnergy', 'co2Reduction', 'batteryInEnergy', 'batteryOutEnergy',
        'pvPower', 'gridPower', 'loadPower',
        'batterySoc', 'batteryPower', 'batteryVoltage', 'batteryCurrent']) {
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
   * Max charge power (Force Charge) / max discharge power (Force Discharge) —
   * cloud-only. Each writes to and activates its own mode.
   */
  async setMaxChargePower(percent) {
    if (!this._cloudAvailable()) throw new Error('Setting max charge power requires cloud credentials');
    await this._cloud.ensureToken(this._email, this._password);
    await this._cloud.setMaxChargePower(this._stationId, percent);
    return 'cloud';
  }

  async setMaxDischargePower(percent) {
    if (!this._cloudAvailable()) throw new Error('Setting max discharge power requires cloud credentials');
    await this._cloud.ensureToken(this._email, this._password);
    await this._cloud.setMaxDischargePower(this._stationId, percent);
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
    let localInfo = null;
    let localDevices = [];

    if (this._local && this._protocol !== 'modbus') {
      try {
        localInfo = await this._local.getGatewayInfo();
        localDevices = await this._local.getRegisteredDevices().catch(() => []);
      } catch (err) {
        this.log('[Hybrid] Local gateway info failed: ' + err.message);
      }
    }

    let cloudInfo = null;
    if (this._cloudAvailable()) {
      try {
        await this._cloud.ensureToken(this._email, this._password);
        cloudInfo = await this._cloud.getDeviceTree(this._stationId);
      } catch (err) {
        this.log('[Hybrid] Cloud device tree failed: ' + err.message);
      }
    }

    if (!localInfo && !cloudInfo) return null;

    // Cloud tree lists DTU + inverter, backup box, battery modules, etc.
    const devices = cloudInfo?.devices?.length
      ? cloudInfo.devices
      : [
          ...(localInfo?.dtuSn
            ? [{
                type:   'DTU',
                status: '',
                gen:    '',
                model:  'DTS/DTU',
                serial: localInfo.dtuSn,
                softwareVer: localInfo.softwareVer || '',
                hardwareVer: localInfo.deviceVer || '',
              }]
            : []),
          ...localDevices,
        ];

    return {
      dtuSn:       cloudInfo?.dtuSn       || localInfo?.dtuSn       || '',
      softwareVer: cloudInfo?.softwareVer  || localInfo?.softwareVer || '',
      deviceVer:   cloudInfo?.deviceVer    || localInfo?.deviceVer   || '',
      model:       cloudInfo?.model        || '',
      devices,
    };
  }

  async probeLocal() {
    // Modbus path: confirm the stick answers on 502
    if (this._modbus && this._protocol !== 'native') {
      const ok = await this._modbus.isReachable();
      this._modbusConfirmed = ok;
      this.log('[Hybrid] Modbus (502): ' + (ok ? 'REACHABLE' : 'no answer'));
      if (ok) { this._localFails = 0; this._localCooldownEnd = 0; return true; }
    }
    if (!this._local || this._protocol === 'modbus') return false;
    const ok = await this._local.isReachable();
    this.log('[Hybrid] Local gateway: ' + (ok ? 'REACHABLE' : 'UNREACHABLE - using cloud'));
    if (ok) {
      this._localFails = 0;
      this._localCooldownEnd = 0;
    } else {
      this._localCooldownEnd = Date.now() + LOCAL_HARD_FAIL_COOLDOWN_MS;
      this.log('[Hybrid] Native 10081 unreachable — pausing retries for 60 min');
    }
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
