'use strict';

/**
 * HoymilesLocal.js
 * ─────────────────────────────────────────────────────────────────────────────
 * DISCLAIMER: Unofficial local communication with the Hoymiles DTS/DTU/gateway
 * over TCP port 10081. Protocol reverse-engineered from:
 *   - github.com/suaveolent/hoymiles-wifi  (MIT) — command bytes, frame
 *     formats and protobuf definitions verified against that project.
 *
 * The HiOne-(8-20)T-G3 hybrid inverter ships with a DTS-WL-G3 data transfer
 * stick (WiFi or LAN mode). The energy-storage (ES) commands below follow the
 * exact flow hoymiles-wifi uses for the HAS/HYS/HYT/HAT hybrid families:
 *
 *   1. GW info (extended frame, serial 0, number 255) → DTU serial number
 *   2. ES registry (extended frame, DTU serial)       → inverter serial(s)
 *   3. ES data (extended frame, DTU + inverter serial)→ live battery/grid/load
 *
 * ⚠️ Field scaling (W vs 0.1 W, % vs 0.1 %) still needs verification on
 * HiOne hardware — raw fields are logged to ease that.
 *
 * NOTE: hoymiles-wifi warns that polling more often than ~every 32 s can
 * disrupt the stick's cloud connection. The app's minimum poll is 30 s.
 *
 * Frame formats ("HM" magic, all big-endian):
 *   standard: HM | cmd(2) | seq(2) | crc16(2) | len(2)=payload+10 | payload
 *   extended: HM | cmd(2) | seq(2) | crc16(2) |
 *             extLen(2)=payload+24 | 0x000e(2) | dtuSerial(8) | 0(2) | nr(2) |
 *             payload                  (payload starts at byte 24)
 *   crc16 = CRC-16/ARC over the protobuf payload.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const net = require('net');

// ─── Command type bytes (hoymiles-wifi const.py, verified) ────────────────────
const CMD = {
  REAL_DATA_NEW:           [0xa3, 0x11],  // CMD_REAL_RES_DTO       (standard)
  COMMAND:                 [0xa3, 0x05],  // CMD_COMMAND_RES_DTO    (standard)
  CLOUD_COMMAND:           [0x23, 0x05],  // CMD_CLOUD_COMMAND_RES  (standard)
  GATEWAY_INFO:            [0xdb, 0x01],  // CMD_GW_INFO_RES_DTO    (extended)
  GATEWAY_NETWORK_INFO:    [0xdb, 0x06],  // CMD_GW_NET_INFO_RES    (extended)
  ENERGY_STORAGE_REGISTRY: [0xc3, 0x02],  // CMD_ES_REG_RES_DTO     (extended)
  ENERGY_STORAGE_DATA:     [0xc3, 0x03],  // CMD_ES_DATA_DTO        (extended)
  ENERGY_STORAGE_USER_SET: [0xc3, 0x08],  // CMD_ES_USER_SET_RES    (extended)
};

// CommandResDTO action ids
const ACTION = {
  MI_START:    6,
  MI_SHUTDOWN: 7,
  LIMIT_POWER: 8,
};

// BMSWorkingMode — same 1-based numbering as the cloud API
// 1 Self-Use, 2 Economic, 3 Backup, 4 Off-Grid, 5 Forced Charging,
// 6 Forced Discharge, 7 Peak Shaving, 8 Time of Use
// Modes that can be set locally without extra schedule/parameter payloads:
const LOCAL_SETTABLE_MODES = [1, 3, 4];

const PORT       = 10081;
const TIMEOUT_MS = 8_000;
const HM_MAGIC   = [0x48, 0x4d];
const OFFSET     = 28800; // fixed offset used by hoymiles-wifi

// ─── CRC-16/ARC ───────────────────────────────────────────────────────────────
function crc16arc(buf) {
  let crc = 0xFFFF;
  for (const byte of buf) {
    let b = byte;
    for (let i = 0; i < 8; i++) {
      if ((crc ^ b) & 1) {
        crc = (crc >>> 1) ^ 0xA001;
      } else {
        crc >>>= 1;
      }
      b >>>= 1;
    }
  }
  return crc & 0xFFFF;
}

// ─── Protobuf helpers (minimal hand-rolled encoding) ──────────────────────────

const PB = {
  varint(fieldNum, value) {
    const tag = (fieldNum << 3) | 0;
    return Buffer.concat([PB._encodeVarint(tag), PB._encodeVarint64(value)]);
  },

  bytes(fieldNum, data) {
    const tag = (fieldNum << 3) | 2;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    return Buffer.concat([PB._encodeVarint(tag), PB._encodeVarint(buf.length), buf]);
  },

  // Packed repeated varint field (proto3 default for repeated scalars)
  packedVarint(fieldNum, values) {
    const payload = Buffer.concat(values.map(v => PB._encodeVarint64(v)));
    return PB.bytes(fieldNum, payload);
  },

  _encodeVarint(value) {
    const bytes = [];
    let v = value >>> 0;
    while (v > 127) {
      bytes.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    bytes.push(v);
    return Buffer.from(bytes);
  },

  // Varint encoding that supports values above 32 bits (int64 serials)
  _encodeVarint64(value) {
    const bytes = [];
    let v = BigInt(value);
    if (v < 0n) v = 0n;
    while (v > 127n) {
      bytes.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    bytes.push(Number(v));
    return Buffer.from(bytes);
  },

  /**
   * Parse a protobuf buffer into a map of fieldNumber → array of values.
   * Repeated fields collect all occurrences; varints above 2^53 stay BigInt.
   */
  parse(buf) {
    const result = {};
    const push = (field, value) => {
      if (!result[field]) result[field] = [];
      result[field].push(value);
    };
    let pos = 0;
    while (pos < buf.length) {
      try {
        const [tagValue, tagLen] = PB._decodeVarint(buf, pos);
        pos += tagLen;
        const fieldNum = Number(tagValue >> 3n);
        const wireType = Number(tagValue & 0x07n);
        switch (wireType) {
          case 0: { // varint
            const [val, len] = PB._decodeVarint(buf, pos);
            push(fieldNum, val <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(val) : val);
            pos += len;
            break;
          }
          case 1: { // 64-bit
            push(fieldNum, buf.readBigUInt64LE(pos));
            pos += 8;
            break;
          }
          case 2: { // length-delimited
            const [len, lenLen] = PB._decodeVarint(buf, pos);
            pos += lenLen;
            push(fieldNum, buf.slice(pos, pos + Number(len)));
            pos += Number(len);
            break;
          }
          case 5: { // 32-bit
            push(fieldNum, buf.readFloatLE(pos));
            pos += 4;
            break;
          }
          default:
            return result;
        }
      } catch (_) {
        break;
      }
    }
    return result;
  },

  _decodeVarint(buf, pos) {
    let value = 0n;
    let shift = 0n;
    let len   = 0;
    while (pos + len < buf.length) {
      const byte = buf[pos + len];
      len++;
      value |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if (!(byte & 0x80)) break;
    }
    return [value, len];
  },

  // First value of a field, or fallback
  one(fields, num, fallback = null) {
    const arr = fields[num];
    return (arr && arr.length > 0) ? arr[0] : fallback;
  },

  // All values of a field (always an array)
  all(fields, num) {
    return fields[num] || [];
  },
};

// ─── Frame builder / parser ───────────────────────────────────────────────────

function buildFrame(cmdBytes, payload, sequence) {
  const crc = crc16arc(payload);
  const length = payload.length + 10;
  const header = Buffer.from([
    ...HM_MAGIC,
    ...cmdBytes,
    (sequence >> 8) & 0xff, sequence & 0xff,
    (crc      >> 8) & 0xff, crc      & 0xff,
    (length   >> 8) & 0xff, length   & 0xff,
  ]);
  return Buffer.concat([header, payload]);
}

function buildExtFrame(cmdBytes, payload, sequence, dtuSerial, number) {
  const crc    = crc16arc(payload);
  const extLen = payload.length + 24;
  const header = Buffer.alloc(24);
  header[0] = HM_MAGIC[0]; header[1] = HM_MAGIC[1];
  header[2] = cmdBytes[0]; header[3] = cmdBytes[1];
  header.writeUInt16BE(sequence & 0xffff, 4);
  header.writeUInt16BE(crc, 6);
  header.writeUInt16BE(extLen & 0xffff, 8);
  header.writeUInt16BE(14, 10);
  header.writeBigUInt64BE(BigInt(dtuSerial || 0), 12);
  header.writeUInt16BE(0, 20);
  header.writeUInt16BE(number & 0xffff, 22);
  return Buffer.concat([header, payload]);
}

function extractPayload(frame) {
  if (frame.length < 10) throw new Error('Frame too short');
  return frame.slice(10);
}

function extractExtPayload(frame) {
  if (frame.length < 24) throw new Error('Extended frame too short');
  const readLength = frame.readUInt16BE(8);
  const end = Math.min(readLength || frame.length, frame.length);
  return frame.slice(24, end);
}

// ─── Request payloads ─────────────────────────────────────────────────────────

function nowYmdHms() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
       + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// RealDataNewResDTO: 1=time_ymd_hms 2=cp 4=offset 5=time
function makeRealDataNewReq() {
  return Buffer.concat([
    PB.bytes(1, nowYmdHms()),
    PB.varint(2, 0),
    PB.varint(4, OFFSET),
    PB.varint(5, Math.floor(Date.now() / 1000)),
  ]);
}

// GWInfoResDTO: 1=cp 2=time 3=offset
function makeGatewayInfoReq() {
  return Buffer.concat([
    PB.varint(2, Math.floor(Date.now() / 1000)),
    PB.varint(3, OFFSET),
  ]);
}

// ESRegResDTO: 1=time 2=time_ymd_hms 3=offset 4=cp
function makeEsRegistryReq() {
  return Buffer.concat([
    PB.varint(1, Math.floor(Date.now() / 1000)),
    PB.bytes(2, nowYmdHms()),
    PB.varint(3, OFFSET),
    PB.varint(4, 0),
  ]);
}

// ESDataResDTO: 1=time 2=time_ymd_hms 3=offset 4=cp 5=serial_number
function makeEsDataReq(inverterSerial) {
  return Buffer.concat([
    PB.varint(1, Math.floor(Date.now() / 1000)),
    PB.bytes(2, nowYmdHms()),
    PB.varint(3, OFFSET),
    PB.varint(4, 0),
    PB.varint(5, inverterSerial),
  ]);
}

// ESUserSetPutResDTO: 1=time 2=tid 3=serial_number(repeated) 4=mode 5=rev_soc
function makeEsUserSetReq(inverterSerial, mode, reserveSoc) {
  const now = Math.floor(Date.now() / 1000);
  const parts = [
    PB.varint(1, now),
    PB.varint(2, now),
    PB.packedVarint(3, [inverterSerial]),
    PB.varint(4, mode),
  ];
  if (reserveSoc !== null && reserveSoc !== undefined) {
    parts.push(PB.varint(5, reserveSoc));
  }
  return Buffer.concat(parts);
}

// CommandResDTO: 1=time 2=action 3=dev_kind 4=package_nub 6=tid 7=data 9=mi_to_sn
function makePowerLimitReq(limitPercent) {
  const now = Math.floor(Date.now() / 1000);
  return Buffer.concat([
    PB.varint(1, now),
    PB.varint(2, ACTION.LIMIT_POWER),
    PB.varint(4, 1),
    PB.varint(6, now),
    PB.bytes(7, `A:${limitPercent * 10},B:0,C:0\r`),
  ]);
}

function makeInverterStateReq(serialInt, on) {
  const now = Math.floor(Date.now() / 1000);
  return Buffer.concat([
    PB.varint(2, on ? ACTION.MI_START : ACTION.MI_SHUTDOWN),
    PB.varint(3, 1), // dev_kind = DEV_DTU
    PB.varint(4, 1),
    PB.varint(6, now),
    PB.packedVarint(9, [serialInt]),
  ]);
}

// ─── TCP transport ────────────────────────────────────────────────────────────

function sendReceive(host, port, frame) {
  return new Promise((resolve, reject) => {
    const socket  = new net.Socket();
    const chunks  = [];
    let settled   = false;

    const done = (err, data) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(data);
    };

    socket.setTimeout(TIMEOUT_MS);
    socket.connect(port, host, () => socket.write(frame));

    socket.on('data',    chunk => chunks.push(chunk));
    socket.on('end',     ()    => done(null, Buffer.concat(chunks)));
    socket.on('timeout', ()    => done(new Error(`Timeout connecting to ${host}:${port}`)));
    socket.on('error',   err   => done(err));
    socket.on('close',   ()    => { if (!settled) done(null, Buffer.concat(chunks)); });
  });
}

// ─── Main class ───────────────────────────────────────────────────────────────

class HoymilesLocal {

  /**
   * @param {object} opts
   * @param {string}   opts.host   IP address of the DTS/gateway on the LAN
   * @param {number}   [opts.port] TCP port (default 10081)
   * @param {Function} opts.log
   * @param {Function} opts.error
   */
  constructor({ host, port, log, error }) {
    this.host  = host;
    this.port  = Number(port) || PORT;
    this.log   = log;
    this.error = error;
    this._seq  = 1;
    this._dtuSerial = null;  // BigInt, discovered via gateway info
    this._invSerial = null;  // BigInt, discovered via ES registry
    this._lastRequestAt = 0;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async isReachable() {
    try {
      await this.getGatewayInfo();
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Fetch gateway/DTU identity info via the extended frame format.
   * Also caches the DTU serial number needed for the ES commands.
   */
  async getGatewayInfo() {
    const response = await this._send(
      buildExtFrame(CMD.GATEWAY_INFO, makeGatewayInfoReq(), this._nextSeq(), 0n, 255),
    );
    const f = PB.parse(extractExtPayload(response));
    this.log(`[Local] getGatewayInfo → fields: ${Object.keys(f).join(',')}`);

    // GWInfoReqDTO: 1=serial_number 5=mgwinfo (GWInfoMO: 2=sw 3=hw) 6=mdevinfo
    const serial = PB.one(f, 1);
    if (serial !== null) this._dtuSerial = BigInt(serial);

    const gwInfo = PB.one(f, 5);
    const gw = gwInfo ? PB.parse(gwInfo) : {};

    return {
      // The printed label / cloud portal show the serial in decimal (e.g.
      // "430525510116"), so render it base-10 to match. The _dtuSerial BigInt
      // used for ES command frames is unaffected by this display string.
      dtuSn:       serial !== null ? BigInt(serial).toString() : '',
      softwareVer: String(PB.one(gw, 2, '') || ''),
      deviceVer:   String(PB.one(gw, 3, '') || ''),
    };
  }

  /**
   * Discover the hybrid inverter serial number via the ES registry.
   */
  async getInverterSerial() {
    if (this._invSerial !== null) return this._invSerial;
    await this._ensureDtuSerial();

    const response = await this._send(
      buildExtFrame(CMD.ENERGY_STORAGE_REGISTRY, makeEsRegistryReq(),
        this._nextSeq(), this._dtuSerial, 1),
    );
    const f = PB.parse(extractExtPayload(response));

    // ESRegReqDTO: 3=inverters (RegInvMO: 1=serial_number 13=model_name)
    const inverters = PB.all(f, 3);
    if (inverters.length === 0) throw new Error('ES registry returned no inverters');

    const inv = PB.parse(inverters[0]);
    const serial = PB.one(inv, 1);
    if (serial === null) throw new Error('ES registry inverter has no serial');
    this._invSerial = BigInt(serial);
    const model = PB.one(inv, 13);
    this.log(`[Local] Inverter: ${this._invSerial.toString(16)}`
      + (model ? ` (${model.toString('utf8')})` : ''));
    return this._invSerial;
  }

  /**
   * Live energy-storage data (battery, grid, load, PV flows).
   * Primary data source for HiOne/hybrid systems.
   */
  async getEnergyStorageData() {
    try {
      await this._ensureDtuSerial();
      const invSerial = await this.getInverterSerial();
      const response = await this._send(
        buildExtFrame(CMD.ENERGY_STORAGE_DATA, makeEsDataReq(invSerial),
          this._nextSeq(), this._dtuSerial, 1),
      );
      const f = PB.parse(extractExtPayload(response));
      this.log(`[Local] getEnergyStorageData → fields: ${Object.keys(f).join(',')}`);

      // ESDataReqDTO: 4=active_power 9=battery(DBmsMO) 10=grid 11=load 17=flow
      const bmsBuf  = PB.one(f, 9);
      const bms     = bmsBuf ? PB.parse(bmsBuf) : {};
      const flowBuf = PB.one(f, 17);
      const flow    = flowBuf ? PB.parse(flowBuf) : {};

      // DBmsMO: 4=state_of_charge 8=power 17=energy_charged 18=energy_discharged
      // DFlowMO: 1=pv_to_load 2=pv_to_battery 3=pv_to_grid 4=battery_to_load
      //          5=grid_to_load 6=battery_to_grid 7=state_of_charge
      const gridPhases = this._sumPhases(PB.one(f, 10), 4);
      const loadPhases = this._sumPhases(PB.one(f, 11), 3);

      return {
        pvPower:      this._watts(PB.one(f, 4, 0)),
        batteryPower: this._watts(PB.one(bms, 8, 0)),
        batterySoc:   this._pct(PB.one(bms, 4, PB.one(flow, 7, 0))),
        gridPower:    this._watts(gridPhases),
        loadPower:    this._watts(loadPhases),
        batteryInEnergy:  this._kwh(PB.one(bms, 17, 0)),
        batteryOutEnergy: this._kwh(PB.one(bms, 18, 0)),
        batteryMode:  null, // not present in ES data; cloud provides the mode
        dailyEnergy:  null,
        totalEnergy:  null,
      };
    } catch (err) {
      this.log(`[Local] getEnergyStorageData failed (${err.message})`);
      return null;
    }
  }

  /**
   * Generic micro-inverter style real data — fallback for non-ES devices.
   */
  async getRealData() {
    const response = await this._send(
      buildFrame(CMD.REAL_DATA_NEW, makeRealDataNewReq(), this._nextSeq()),
    );
    const f = PB.parse(extractPayload(response));
    this.log(`[Local] getRealData → fields: ${Object.keys(f).join(',')}`);

    // RealDataNewReqDTO: 12=dtu_power (W); detailed channel data in 6..11
    return {
      pvPower:      this._watts(PB.one(f, 12, 0)),
      batteryPower: 0,
      batterySoc:   0,
      gridPower:    0,
      loadPower:    0,
      batteryMode:  null,
    };
  }

  /**
   * Set the battery working mode locally (ES user set).
   * Only modes without schedule payloads are supported locally: 1 (Self-Use),
   * 3 (Backup), 4 (Off-Grid). Other modes must be set via the cloud.
   *
   * @param {number} mode        1–8 (cloud-compatible numbering)
   * @param {number} [reserveSoc] optional reserve SOC percentage
   */
  async setBatteryMode(mode, reserveSoc = null) {
    const modeNum = Number(mode);
    if (!LOCAL_SETTABLE_MODES.includes(modeNum)) {
      throw new Error(`Mode ${mode} cannot be set locally (needs schedule/parameters)`);
    }
    await this._ensureDtuSerial();
    const invSerial = await this.getInverterSerial();
    const response = await this._send(
      buildExtFrame(CMD.ENERGY_STORAGE_USER_SET,
        makeEsUserSetReq(invSerial, modeNum, reserveSoc),
        this._nextSeq(), this._dtuSerial, 1),
    );
    // ESUserSetPutReqDTO: 4=err_code (0 = OK)
    const f = PB.parse(extractExtPayload(response));
    const errCode = PB.one(f, 4, 0);
    if (errCode !== 0) throw new Error(`Gateway rejected mode change (err ${errCode})`);
    this.log(`[Local] setBatteryMode(${modeNum}) → OK`);
    return true;
  }

  /**
   * Set the inverter output power limit (percent of rated power).
   *
   * ⚠️ Each change writes to the inverter's EEPROM — avoid frequent
   * automated changes (a few times per day is fine).
   */
  async setPowerLimit(limitPercent) {
    const limit = Math.round(Number(limitPercent));
    if (isNaN(limit) || limit < 0 || limit > 100) {
      throw new Error(`Invalid power limit: ${limitPercent}`);
    }
    const response = await this._send(
      buildFrame(CMD.COMMAND, makePowerLimitReq(limit), this._nextSeq()),
    );
    extractPayload(response);
    this.log(`[Local] setPowerLimit(${limit}%) → sent`);
    return true;
  }

  /**
   * Turn an inverter on or off by its serial number (hex string).
   */
  async setInverterState(serialHex, on) {
    const serial = String(serialHex || '').trim();
    if (!/^[0-9a-fA-F]{8,16}$/.test(serial)) {
      throw new Error(`Invalid inverter serial number: ${serialHex}`);
    }
    const response = await this._send(
      buildFrame(CMD.CLOUD_COMMAND,
        makeInverterStateReq(BigInt(`0x${serial}`), Boolean(on)),
        this._nextSeq()),
    );
    extractPayload(response);
    this.log(`[Local] setInverterState(${serial}, ${on ? 'ON' : 'OFF'}) → sent`);
    return true;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  async _ensureDtuSerial() {
    if (this._dtuSerial === null) await this.getGatewayInfo();
    if (this._dtuSerial === null) throw new Error('Could not discover DTU serial number');
  }

  // The stick gets confused by rapid successive connections — keep ≥2s spacing
  async _send(frame) {
    const wait = this._lastRequestAt + 2_000 - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    try {
      return await sendReceive(this.host, this.port, frame);
    } finally {
      this._lastRequestAt = Date.now();
    }
  }

  _nextSeq() {
    const s = this._seq;
    this._seq = (this._seq + 1) & 0xffff;
    return s;
  }

  // Sum one numeric field over all phases of a DGridMO/DLoadMO-style message
  _sumPhases(buf, powerField) {
    if (!buf) return 0;
    const parsed = PB.parse(buf);
    let total = 0;
    for (const phaseBuf of PB.all(parsed, 2)) {
      const phase = PB.parse(phaseBuf);
      total += Number(PB.one(phase, powerField, 0)) || 0;
    }
    return total;
  }

  _watts(raw) {
    const v = Number(raw);
    if (isNaN(v)) return 0;
    // Values may arrive as W, 0.1 W or mW — normalise heuristically
    if (Math.abs(v) > 1_000_000) return Math.round(v / 1000);
    return v;
  }

  _pct(raw) {
    const v = Number(raw);
    if (isNaN(v)) return 0;
    if (v > 1000) return Math.round(v / 100); // hundredths of a percent
    if (v > 100)  return Math.round(v / 10);  // tenths of a percent
    return Math.round(v);
  }

  _kwh(raw) {
    const v = Number(raw);
    if (isNaN(v)) return 0;
    // Likely Wh — convert to kWh
    return v > 10_000 ? Math.round(v / 10) / 100 : Math.round(v * 100) / 100;
  }

  _str(raw) {
    if (!raw) return '';
    if (Buffer.isBuffer(raw)) return raw.toString('utf8').replace(/\0/g, '');
    return String(raw);
  }
}

module.exports = HoymilesLocal;
module.exports.CMD = CMD;
module.exports.LOCAL_SETTABLE_MODES = LOCAL_SETTABLE_MODES;
// Exposed for diagnostics and protocol tests
module.exports._internals = { PB, buildFrame, buildExtFrame, crc16arc };
