'use strict';

/**
 * HoymilesModbus.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Local communication with a Hoymiles DTS-G3 / DTU-Pro data stick over
 * Modbus TCP (default port 502). Hand-rolled minimal Modbus TCP client — no
 * external dependency, matching the rest of this project.
 *
 * IMPORTANT — enable Modbus on the stick first:
 *   The DTS/DTU ships in "Export Management" mode and stays silent on port 502.
 *   In the S-Miles Installer app: Me → Local Install Assistant (Toolkit) →
 *   DTU Information → RS485 Port Config → choose "Remote Control"
 *   (NOT "Export Control" — that blocks Modbus). RS485/Modbus address must be
 *   set in the 101–254 range. Source: Hoymiles Modbus Implementation Technical
 *   Note V1.2 (registers 0x2501 Ethernet port, 0x2503 RS485 Function
 *   0=Export Management/1=Hoymiles Modbus, 0x2504 port address 101–254).
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
 * Battery / energy-storage data registers — UNKNOWN for the HiOne hybrid.
 * Fill these in after running scan() against the live stick. Each entry maps a
 * field to { addr, words, scale, signed }. Leave null until calibrated.
 */
const BATTERY_REGISTERS = null;

class HoymilesModbus {

  /**
   * @param {object} opts
   * @param {string}   opts.host
   * @param {number}   [opts.port]    default 502
   * @param {number}   [opts.unitId]  Modbus slave id (101–254 on Hoymiles)
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
    try {
      await this._request(unitId, FC.READ_HOLDING, REG.POWER_LIMIT_ALL, 1);
      return true;
    } catch (err) {
      // A Modbus *exception* still proves it speaks Modbus
      if (/Modbus exception/.test(err.message)) return true;
      return false;
    }
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
   * Best-effort live data read. Returns null until BATTERY_REGISTERS is
   * calibrated from a scan of the HiOne hybrid stick.
   */
  async getData() {
    if (!BATTERY_REGISTERS) return null;
    const out = {};
    for (const [field, def] of Object.entries(BATTERY_REGISTERS)) {
      try {
        const words = await this.readRegisters(def.addr, def.words || 1);
        out[field] = this._decode(words, def);
        await this._gap();
      } catch (err) {
        this.log(`[Modbus] read ${field} failed: ${err.message}`);
        out[field] = null;
      }
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

  _request(unitId, fc, addr, valueOrQty) {
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

module.exports = HoymilesModbus;
module.exports.REG = REG;
module.exports.FC = FC;
