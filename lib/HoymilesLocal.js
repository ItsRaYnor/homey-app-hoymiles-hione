'use strict';

/**
 * HoymilesLocal.js
 * ─────────────────────────────────────────────────────────────────────────────
 * DISCLAIMER: Unofficial local communication with the Hoymiles HiBox gateway.
 * Protocol reverse-engineered from:
 *   - github.com/suaveolent/hoymiles-wifi  (MIT)
 *   - github.com/henkwiedig/Hoymiles-DTU-Proto (reference)
 *
 * ⚠️  HARDWARE NOTE
 * Command bytes for energy-storage specific messages (CMD_ENERGY_*) are based
 * on the hoymiles-wifi library's hybrid-inverter support. They have NOT yet
 * been verified on the HiBox-63T-G3 gateway shipped with the HiOne BESS.
 * If data comes back empty/wrong, update the CMD_* constants below first.
 *
 * Protocol framing (TCP port 10081):
 *   [0] 0x48 0x4D        "HM" magic
 *   [2] cmd_hi cmd_lo    command type (2 bytes)
 *   [4] seq_hi seq_lo    sequence number (2 bytes, big-endian)
 *   [6] crc_hi crc_lo    CRC-16/ARC over protobuf payload (2 bytes, big-endian)
 *   [8] len_hi len_lo    total frame length including 10-byte header (2 bytes)
 *   [10..] payload       protobuf-encoded message
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

const net = require('net');

// ─── Command type bytes ────────────────────────────────────────────────────────
// Source: hoymiles-wifi Python library (reverse-engineered)
const CMD = {
  REAL_DATA_NEW:             [0x09, 0x1c],  // GetRealDataNewResDTO  ✓ confirmed
  GATEWAY_INFO:              [0x01, 0x95],  // GetGatewayInfoResDTO  ✓ confirmed
  GATEWAY_NETWORK_INFO:      [0x01, 0x96],  // GetGatewayNetworkInfoResDTO
  ENERGY_STORAGE_REGISTRY:   [0x01, 0xd4],  // ⚠️ needs HiOne hardware verification
  ENERGY_STORAGE_DATA:       [0x01, 0xd7],  // ⚠️ needs HiOne hardware verification
  SET_ENERGY_STORAGE_MODE:   [0x01, 0xd8],  // ⚠️ needs HiOne hardware verification
};

const PORT         = 10081;
const TIMEOUT_MS   = 8_000;
const HM_MAGIC     = [0x48, 0x4d];

// ─── CRC-16/ARC ───────────────────────────────────────────────────────────────
// poly=0x8005, init=0xFFFF, refIn=true, refOut=true, xorOut=0x0000
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
// We only need a tiny subset: varint fields and length-delimited strings.
// This avoids adding a heavy npm dependency.

const PB = {
  // Encode a varint (field type 0)
  varint(fieldNum, value) {
    const tag = (fieldNum << 3) | 0;
    return Buffer.concat([PB._encodeVarint(tag), PB._encodeVarint(value >>> 0)]);
  },

  // Encode a 32-bit fixed (field type 5) — used for floats
  fixed32(fieldNum, value) {
    const tag = (fieldNum << 3) | 5;
    const buf = Buffer.alloc(5);
    buf.writeUInt8(tag, 0);
    buf.writeFloatLE(value, 1);
    return buf;
  },

  // Encode length-delimited bytes (field type 2) — for nested messages/strings
  bytes(fieldNum, data) {
    const tag = (fieldNum << 3) | 2;
    return Buffer.concat([PB._encodeVarint(tag), PB._encodeVarint(data.length), data]);
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

  // Parse a response buffer into a flat key→value map (field_number → value)
  parse(buf) {
    const result = {};
    let pos = 0;
    while (pos < buf.length) {
      try {
        const [tagValue, tagLen] = PB._decodeVarint(buf, pos);
        pos += tagLen;
        const fieldNum  = tagValue >>> 3;
        const wireType  = tagValue & 0x07;
        switch (wireType) {
          case 0: { // varint
            const [val, len] = PB._decodeVarint(buf, pos);
            result[fieldNum] = val;
            pos += len;
            break;
          }
          case 1: { // 64-bit
            result[fieldNum] = buf.readBigUInt64LE(pos);
            pos += 8;
            break;
          }
          case 2: { // length-delimited
            const [len, lenLen] = PB._decodeVarint(buf, pos);
            pos += lenLen;
            result[fieldNum] = buf.slice(pos, pos + len);
            pos += len;
            break;
          }
          case 5: { // 32-bit (float/fixed32)
            result[fieldNum] = buf.readFloatLE(pos);
            pos += 4;
            break;
          }
          default:
            return result; // unknown wire type → stop
        }
      } catch (_) {
        break;
      }
    }
    return result;
  },

  _decodeVarint(buf, pos) {
    let value = 0;
    let shift = 0;
    let len   = 0;
    while (pos + len < buf.length) {
      const byte = buf[pos + len];
      len++;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return [value >>> 0, len];
  },
};

// ─── Frame builder / parser ───────────────────────────────────────────────────

function buildFrame(cmdBytes, payload, sequence) {
  const crc    = crc16arc(payload);
  const length = payload.length + 10; // total incl. 10-byte header
  const header = Buffer.from([
    ...HM_MAGIC,
    ...cmdBytes,
    (sequence >> 8) & 0xff, sequence & 0xff,
    (crc    >> 8) & 0xff, crc    & 0xff,
    (length >> 8) & 0xff, length & 0xff,
  ]);
  return Buffer.concat([header, payload]);
}

function extractPayload(frame) {
  if (frame.length < 10) throw new Error('Frame too short');
  return frame.slice(10);
}

// ─── Request payloads ─────────────────────────────────────────────────────────
// These mirror the Python library's DTO constructors.

function makeRealDataNewReq(offset = 28800) {
  // NetworkInfoResDTO-compatible: field 1 = offset, field 2 = timestamp
  return Buffer.concat([
    PB.varint(1, offset),
    PB.varint(2, Math.floor(Date.now() / 1000)),
  ]);
}

function makeEnergyStorageDataReq(offset = 28800) {
  return Buffer.concat([
    PB.varint(1, offset),
    PB.varint(2, Math.floor(Date.now() / 1000)),
  ]);
}

function makeGatewayInfoReq(offset = 28800) {
  return Buffer.concat([
    PB.varint(1, offset),
    PB.varint(2, Math.floor(Date.now() / 1000)),
  ]);
}

/**
 * Build a SetEnergyStorageWorkingMode payload.
 * @param {number} mode  0=Self-Consumption 1=Economy 2=Backup 3=Off-Grid 4=Peak 5=ToU
 */
function makeSetModeReq(mode, offset = 28800) {
  return Buffer.concat([
    PB.varint(1, offset),
    PB.varint(2, Math.floor(Date.now() / 1000)),
    PB.varint(3, mode),
  ]);
}

// ─── TCP transport ────────────────────────────────────────────────────────────

function sendReceive(host, frame) {
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
    socket.connect(PORT, host, () => socket.write(frame));

    socket.on('data',    chunk => chunks.push(chunk));
    socket.on('end',     ()    => done(null, Buffer.concat(chunks)));
    socket.on('timeout', ()    => done(new Error(`Timeout connecting to ${host}:${PORT}`)));
    socket.on('error',   err   => done(err));
    // Some DTUs close the connection once response is sent – give a short grace
    socket.on('close',   ()    => { if (!settled) done(null, Buffer.concat(chunks)); });
  });
}

// ─── Main class ───────────────────────────────────────────────────────────────

class HoymilesLocal {

  /**
   * @param {object} opts
   * @param {string}   opts.host   IP address of the HiBox-63T-G3 gateway
   * @param {Function} opts.log
   * @param {Function} opts.error
   */
  constructor({ host, log, error }) {
    this.host  = host;
    this.log   = log;
    this.error = error;
    this._seq  = 1;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Test if the gateway is reachable on the local network.
   * @returns {Promise<boolean>}
   */
  async isReachable() {
    try {
      await this.getGatewayInfo();
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Fetch gateway identity info (serial number, firmware version, etc.)
   */
  async getGatewayInfo() {
    const payload  = makeGatewayInfoReq();
    const frame    = buildFrame(CMD.GATEWAY_INFO, payload, this._nextSeq());
    const response = await sendReceive(this.host, frame);
    const fields   = PB.parse(extractPayload(response));
    this.log(`[Local] getGatewayInfo → ${Object.keys(fields).length} fields`);
    return {
      dtuSn:       this._str(fields[1]),
      deviceVer:   this._str(fields[4]),
      softwareVer: this._str(fields[5]),
    };
  }

  /**
   * Fetch live PV/battery/grid/load data from the gateway.
   *
   * ⚠️ Field mapping below is based on the hoymiles-wifi library for
   * hybrid inverters (HYS/HYT series). Verify field numbers on HiOne hardware.
   *
   * @returns {Promise<{pvPower, batteryPower, batterySoc, gridPower, loadPower, batteryMode}>}
   */
  async getRealData() {
    const payload  = makeRealDataNewReq();
    const frame    = buildFrame(CMD.REAL_DATA_NEW, payload, this._nextSeq());
    const response = await sendReceive(this.host, frame);
    const f        = PB.parse(extractPayload(response));

    this.log(`[Local] getRealData → fields: ${Object.keys(f).join(',')}`);

    // Field numbers from hoymiles-wifi GetRealDataNewReqDTO
    // NOTE: pv_power may also be aggregated across multiple inverters in field 11
    return {
      pvPower:      this._watts(f[11] ?? f[6]  ?? 0),
      batteryPower: this._watts(f[18] ?? f[17] ?? 0),
      batterySoc:   this._pct  (f[19] ?? 0),
      gridPower:    this._watts(f[16] ?? f[9]  ?? 0),
      loadPower:    this._watts(f[20] ?? f[10] ?? 0),
      batteryMode:  String(f[21] ?? f[14] ?? 0),
    };
  }

  /**
   * Fetch energy storage specific data (battery-focused).
   *
   * ⚠️ Command ID and field mapping need hardware verification on HiOne/HiBox.
   * Falls back gracefully if command is unsupported.
   */
  async getEnergyStorageData() {
    try {
      const payload  = makeEnergyStorageDataReq();
      const frame    = buildFrame(CMD.ENERGY_STORAGE_DATA, payload, this._nextSeq());
      const response = await sendReceive(this.host, frame);
      const f        = PB.parse(extractPayload(response));

      this.log(`[Local] getEnergyStorageData → fields: ${Object.keys(f).join(',')}`);

      return {
        batterySoc:      this._pct  (f[1]  ?? 0),
        batteryPower:    this._watts(f[2]  ?? 0),
        batteryMode:     String(f[3] ?? 0),
        dailyEnergy:     this._kwh  (f[8]  ?? 0),
        totalEnergy:     this._kwh  (f[9]  ?? 0),
      };
    } catch (err) {
      this.log(`[Local] getEnergyStorageData failed (${err.message}) — falling back to getRealData`);
      return null; // caller will use getRealData fields instead
    }
  }

  /**
   * Set battery operating mode.
   *
   * ⚠️ Command ID needs hardware verification on HiOne/HiBox.
   *
   * @param {number} mode  0–5
   */
  async setBatteryMode(mode) {
    const payload  = makeSetModeReq(mode);
    const frame    = buildFrame(CMD.SET_ENERGY_STORAGE_MODE, payload, this._nextSeq());
    const response = await sendReceive(this.host, frame);
    const f        = PB.parse(extractPayload(response));
    // Status field 1 = 0 means success in most Hoymiles responses
    const status   = f[1] ?? 0;
    if (status !== 0) throw new Error(`Gateway rejected mode change (status ${status})`);
    this.log(`[Local] setBatteryMode(${mode}) → OK`);
    return true;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _nextSeq() {
    const s   = this._seq;
    this._seq = (this._seq + 1) & 0xffff;
    return s;
  }

  _watts(raw) {
    const v = typeof raw === 'bigint' ? Number(raw) : Number(raw);
    // Values may arrive as watts (int) or milliwatts — normalise
    return isNaN(v) ? 0 : (v > 100_000 ? Math.round(v / 1000) : v);
  }

  _pct(raw) {
    const v = Number(raw);
    // May arrive as 0–100 or 0–10000 (hundredths of percent)
    if (isNaN(v)) return 0;
    return v > 100 ? Math.round(v / 100) : Math.round(v);
  }

  _kwh(raw) {
    const v = Number(raw);
    if (isNaN(v)) return 0;
    // May arrive as Wh or kWh — normalise to kWh
    return v > 10_000 ? Math.round(v / 100) / 10 : Math.round(v * 100) / 100;
  }

  _str(raw) {
    if (!raw) return '';
    if (Buffer.isBuffer(raw)) return raw.toString('utf8').replace(/\0/g, '');
    return String(raw);
  }
}

module.exports = HoymilesLocal;
module.exports.CMD = CMD;  // expose for diagnostics/override
