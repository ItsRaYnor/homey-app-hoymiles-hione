'use strict';

/**
 * HoymilesModbus.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Local communication with a Hoymiles DTS-G3 / DTU-Pro data stick over
 * Modbus TCP (default port 502). Hand-rolled minimal Modbus TCP client — no
 * external dependency, matching the rest of this project.
 *
 * UNIT ID — try 1 first:
 *   Verified live on a DTS-WL-G3 (2026-07-30): it answers on unit id 1 with no
 *   configuration at all, via FC04 (input registers). The docs suggest 101–254,
 *   which only applies once RS485 "Remote Control" has been configured. Note it
 *   does NOT answer FC03 @0xC001, so probe FC04 @0x0000 too before concluding
 *   that Modbus is disabled (isReachable does exactly that).
 *
 *   If a stick really is silent, it is in "Export Management" mode: S-Miles
 *   Installer app → Me → Local Install Assistant (Toolkit) → DTU Information →
 *   RS485 Port Config → "Remote Control" (NOT "Export Control"), address
 *   101–254. Source: Hoymiles Modbus Implementation Technical Note V1.2
 *   (0x2501 Ethernet port, 0x2503 RS485 Function 0=Export Management/
 *   1=Hoymiles Modbus, 0x2504 port address 101–254).
 *
 * Documented microinverter registers (used for control; may differ on the
 * HiOne hybrid — verify with scan()):
 *   0xC000  Turn ON/OFF all          (FC 0x05 write coil; 0=off 1=on)
 *   0xC001  Limit Active Power all    (FC 0x05/0x06; percentage 2–100)
 *   0x1010  PV Power (W), 0x1012 Today (Wh), 0x1014 Total (Wh) ... per port
 *
 * The HiOne hybrid/BESS battery registers (SoC, charge/discharge) are not
 * published; discover them with scan() once Modbus is enabled, then fill in
 * BATTERY_REGISTERS below.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const net = require('net');

const DEFAULT_PORT = 502;
const TIMEOUT_MS   = 5_000;
// Minimum spacing between two requests to the same stick (see _request).
const REQUEST_GAP_MS = 150;

// Function codes
const FC = {
  READ_HOLDING: 0x03,
  READ_INPUT:   0x04,
  WRITE_COIL:   0x05,
  WRITE_SINGLE: 0x06,
  WRITE_MULTI:  0x10,
};

// Documented control registers (microinverter map; confirm on hybrid)
const REG = {
  POWER_ON_OFF_ALL: 0xC000, // FC05 coil
  POWER_LIMIT_ALL:  0xC001, // percentage 2–100
};

/**
 * Battery / energy-storage data registers for the HiOne hybrid, on Modbus
 * unit id 1 (FC04 / input registers). Verified live on real hardware
 * (2026-07-30/31) by correlating simultaneous S-Miles cloud readings
 * (es.soc / es.bp / IND_BMS) across charging, self-consumption and Force
 * Discharge (~5880 W) states.
 *
 *   0x00B4  tracked SoC exactly and unscaled (50→49→48→49) on every sample.
 *   0x00C1  matched battery power exactly in both directions as a signed
 *           int16: +5880 raw while discharging 5880 W, and -8000 raw
 *           (57536 unsigned) while charging 8000 W — i.e. positive while
 *           DISCHARGING, negative while CHARGING. Negated below (scale: -1)
 *           to match Homey's convention (positive = charging). Other
 *           candidates tested (0x0033, off by ~1W; 0x0063/0x0125, which
 *           looked promising at first but did not hold up across multiple
 *           charge levels) were discarded.
 *   0x002E  tracked the IND_BMS pack voltage at 0.1 V resolution: raw 260
 *           at 26.0 V and raw 256 at 25.6 V under Force Discharge.
 *
 * Battery current is not exposed as a simple register in 0x0000–0x01FF.
 * getData() derives it from power / voltage; PV/grid/load are topped up from
 * cloud (see HoymilesHybrid._mergeCloudEnergy).
 */
const BATTERY_REGISTERS = {
  batterySoc:     { addr: 0x00B4, words: 1, input: true },
  batteryPower:   { addr: 0x00C1, words: 1, input: true, signed: true, scale: -1 },
  batteryVoltage: { addr: 0x002E, words: 1, input: true, scale: 0.1 },
};

class HoymilesModbus {

  /**
   * @param {object} opts
   * @param {string}   opts.host
   * @param {number}   [opts.port]    default 502
   * @param {number}   [opts.unitId]  Modbus slave id (default 1; 101–254 when
   *                                  RS485 "Remote Control" has been configured)
   * @param {Function} opts.log
   * @param {Function} opts.error
   */
  constructor({ host, port, unitId, log, error }) {
    this.host   = host;
    this.port   = Number(port) || DEFAULT_PORT;
    this.unitId = Number(unitId) || 1;
    this.log    = log;
    this.error  = error;
    this._tid   = 0;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Confirm the stick answers Modbus on the configured unit id.
   * Returns true on any valid Modbus response (data OR exception).
   */
  async isReachable(unitId = this.unitId) {
    // Prefer the documented control register; DTS sticks that only expose a
    // stub map often answer FC04 @0 instead (seen live on DTS-WL-G3).
    try {
      await this._request(unitId, FC.READ_HOLDING, REG.POWER_LIMIT_ALL, 1);
      return true;
    } catch (err) {
      if (/Modbus exception/.test(err.message)) return true;
    }
    try {
      await this._request(unitId, FC.READ_INPUT, 0x0000, 1);
      return true;
    } catch (err) {
      if (/Modbus exception/.test(err.message)) return true;
    }
    return false;
  }

  /**
   * Read holding (FC03) or input (FC04) registers → array of 16-bit words.
   */
  async readRegisters(addr, qty, { input = false, unitId = this.unitId } = {}) {
    const fc = input ? FC.READ_INPUT : FC.READ_HOLDING;
    const payload = await this._request(unitId, fc, addr, qty);
    const words = [];
    // payload[0] = byte count, then big-endian 16-bit words
    for (let i = 1; i + 1 < payload.length; i += 2) {
      words.push(payload.readUInt16BE(i));
    }
    return words;
  }

  /**
   * Discovery helper: read a register range in chunks and return a map of
   * { '0xXXXX': value }. Use this against the live stick to locate the
   * battery SoC / power registers, then populate BATTERY_REGISTERS.
   *
   * @param {number} start  first register address
   * @param {number} count  how many registers to read
   * @param {object} [opts] { input, unitId, chunk }
   */
  async scan(start, count, { input = false, unitId = this.unitId, chunk = 32 } = {}) {
    const result = {};
    for (let off = 0; off < count; off += chunk) {
      const qty = Math.min(chunk, count - off);
      try {
        const words = await this.readRegisters(start + off, qty, { input, unitId });
        words.forEach((w, i) => {
          const a = start + off + i;
          result['0x' + a.toString(16).toUpperCase().padStart(4, '0')] = w;
        });
      } catch (err) {
        this.log(`[Modbus] scan ${start + off}..+${qty} failed: ${err.message}`);
      }
      await this._gap();
    }
    return result;
  }

  /**
   * Set the output power limit (percentage). Documented register 0xC001.
   * @param {number} percent 2–100
   */
  async setPowerLimit(percent) {
    const pct = Math.round(Number(percent));
    if (isNaN(pct) || pct < 2 || pct > 100) throw new Error(`Invalid power limit: ${percent}`);
    await this._request(this.unitId, FC.WRITE_SINGLE, REG.POWER_LIMIT_ALL, pct);
    this.log(`[Modbus] setPowerLimit(${pct}%) → sent`);
    return true;
  }

  /**
   * Turn all inverters on/off. Documented coil register 0xC000.
   */
  async setInverterState(on) {
    await this._writeCoil(this.unitId, REG.POWER_ON_OFF_ALL, Boolean(on));
    this.log(`[Modbus] setInverterState(${on ? 'ON' : 'OFF'}) → sent`);
    return true;
  }

  /**
   * Best-effort live battery read from the calibrated register map.
   */
  async getData() {
    if (!BATTERY_REGISTERS) return null;
    const out = {};
    for (const [field, def] of Object.entries(BATTERY_REGISTERS)) {
      try {
        const words = await this.readRegisters(def.addr, def.words || 1, { input: def.input });
        out[field] = this._decode(words, def);
        await this._gap();
      } catch (err) {
        this.log(`[Modbus] read ${field} failed: ${err.message}`);
        out[field] = null;
      }
    }
    // No dedicated current register was found. This calculation matched the
    // simultaneous IND_BMS sample: 5879 W / 25.6 V ≈ 229.6 A (reported 229.3 A).
    if (typeof out.batteryPower === 'number'
      && typeof out.batteryVoltage === 'number'
      && out.batteryVoltage > 0.5) {
      out.batteryCurrent = Math.round((out.batteryPower / out.batteryVoltage) * 100) / 100;
    } else {
      out.batteryCurrent = null;
    }
    return out;
  }

  // ── Modbus framing ────────────────────────────────────────────────────────

  async _writeCoil(unitId, addr, on) {
    // FC05: value 0xFF00 = ON, 0x0000 = OFF
    return this._request(unitId, FC.WRITE_COIL, addr, on ? 0xFF00 : 0x0000);
  }

  _buildFrame(unitId, fc, addr, valueOrQty) {
    const tid = (this._tid = (this._tid + 1) & 0xffff);
    const pdu = Buffer.alloc(5);
    pdu.writeUInt8(fc, 0);
    pdu.writeUInt16BE(addr, 1);
    pdu.writeUInt16BE(valueOrQty & 0xffff, 3);

    const mbap = Buffer.alloc(7);
    mbap.writeUInt16BE(tid, 0);       // transaction id
    mbap.writeUInt16BE(0, 2);         // protocol id = 0
    mbap.writeUInt16BE(pdu.length + 1, 4); // length = unit + pdu
    mbap.writeUInt8(unitId & 0xff, 6);
    return { frame: Buffer.concat([mbap, pdu]), tid, fc };
  }

  /**
   * Serialise every request per stick. The DTS-WL-G3 handles only one
   * connection at a time: two devices polling it concurrently (which happens
   * as soon as a second HiOne device picks up the same saved gateway IP) makes
   * it reset connections — observed live as a steady stream of ECONNRESET /
   * "Connection closed without response" from both devices at the same
   * millisecond. Queuing per host+port, with a small gap between requests,
   * keeps every caller on the same lane instead of colliding.
   */
  _request(unitId, fc, addr, valueOrQty) {
    const key  = `${this.host}:${this.port}`;
    const prev = HoymilesModbus._queues.get(key) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        await new Promise(r => setTimeout(r, REQUEST_GAP_MS));
        return this._rawRequest(unitId, fc, addr, valueOrQty);
      });
    // Store a never-rejecting tail so one failure doesn't poison the chain.
    HoymilesModbus._queues.set(key, next.catch(() => {}));
    return next;
  }

  _rawRequest(unitId, fc, addr, valueOrQty) {
    const { frame, fc: sentFc } = this._buildFrame(unitId, fc, addr, valueOrQty);
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const chunks = [];
      let settled = false;
      const done = (err, data) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        err ? reject(err) : resolve(data);
      };

      socket.setTimeout(TIMEOUT_MS);
      socket.connect(this.port, this.host, () => socket.write(frame));

      socket.on('data', (chunk) => {
        chunks.push(chunk);
        const buf = Buffer.concat(chunks);
        if (buf.length < 8) return; // need MBAP (7) + at least fc
        const len = buf.readUInt16BE(4);          // bytes after the length field
        if (buf.length < 6 + len) return;          // wait for full PDU
        const respFc = buf.readUInt8(7);
        if (respFc & 0x80) {
          const code = buf.length > 8 ? buf.readUInt8(8) : 0;
          return done(new Error(`Modbus exception ${code} (fc ${sentFc})`));
        }
        done(null, buf.slice(8)); // PDU payload after unit+fc
      });

      socket.on('timeout', () => done(new Error(`Timeout on ${this.host}:${this.port}`)));
      socket.on('error',   (err) => done(err));
      socket.on('close',   () => { if (!settled) done(new Error('Connection closed without response')); });
    });
  }

  _decode(words, def) {
    let raw = 0;
    for (const w of words) raw = (raw << 16) | w;
    if (def.signed) {
      const bits = words.length * 16;
      if (raw >= 2 ** (bits - 1)) raw -= 2 ** bits;
    }
    return def.scale ? Math.round((raw * def.scale) * 100) / 100 : raw;
  }

  _gap() {
    return new Promise(resolve => setTimeout(resolve, 120));
  }
}

// Shared across every HoymilesModbus instance in the app (one per device), so
// two devices pointing at the same stick queue behind each other.
HoymilesModbus._queues = new Map();

module.exports = HoymilesModbus;
module.exports.REG = REG;
module.exports.FC = FC;
