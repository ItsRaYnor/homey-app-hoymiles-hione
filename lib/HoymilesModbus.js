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
// Close a connection that has gone unused for this long. Long enough that
// consecutive polls reuse the same socket, short enough that a stick which
// reboots is not left holding a dead one.
const IDLE_CLOSE_MS = 120_000;
// After a failed connect, fail fast for this long instead of paying a full
// connect timeout for every field in the same poll.
const CONNECT_BACKOFF_MS = 10_000;
// How long a previous reading stays relevant for the rate-of-change check.
// Longer than a poll interval, short enough that a restart or a long outage
// does not reject a legitimately different value.
const SOC_JUMP_WINDOW_MS = 10 * 60_000;

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
 * getData() derives it from power / voltage.
 *
 * GRID / LOAD block (found 2026-07-31, verified against a simultaneous
 * IND_GRID + IND_LOAD cloud event query and stable over three consecutive
 * reads). This is the meter data the Backup Box feeds in — it was missed for a
 * long time because the searches only covered 0x0000–0x04FF partially:
 *
 *   0x0417/18/19  grid voltage per phase   ×0.1 V  (237.3/235.9/236.6 vs cloud 237.1/235.4/236.3)
 *   0x041A/1B/1C  grid current per phase   ×0.01 A (2.74/4.75/2.91 vs cloud 2.74/4.67/2.91 — A and C exact)
 *   0x041D        grid frequency           ×0.01 Hz
 *   0x041E/1F/20  grid active power/phase  signed W (−115/−667/−79 vs cloud −114/−632/−65)
 *   0x0421/22/23  grid reactive power      Var (640/900/686 vs cloud 640/900/685 — near exact)
 *   0x0875        grid active power TOTAL  signed W — independently verified: it
 *                 equals the sum of the three phase registers on every read
 *                 (−879 = −115 + −690 + −74), which rules out coincidence.
 *   0x0879/7B/7C  load active power/phase  W (cloud IND_LOAD 163/629/95)
 *
 * Sign convention on the grid registers is NEGATIVE while importing from the
 * grid (cloud reports the same sign), so grid power is negated below to match
 * Homey's convention of positive = importing.
 */
// Each entry carries a plausible range. Under concurrent access this stick can
// return 0xFFFF ("no data") or a response belonging to a different request —
// seen live as a battery voltage of 6553.5 V (65535 × 0.1) and two unrelated
// fields reading the exact same number. Without bounds those land in the app as
// if they were real measurements, so anything outside the range is dropped.
const BATTERY_REGISTERS = {
  // maxJump guards against a bad read that lands inside the valid range: seen
  // live at 92% followed by 0% twenty seconds later. A range check cannot
  // catch that, because 0 is a legal state of charge — only the rate of change
  // gives it away.
  batterySoc:     { addr: 0x00B4, words: 1, input: true, min: 0, max: 100, maxJump: 25 },
  batteryPower:   { addr: 0x00C1, words: 1, input: true, signed: true, scale: -1, min: -30000, max: 30000 },
  batteryVoltage: { addr: 0x002E, words: 1, input: true, scale: 0.1, min: 5, max: 120 },
  gridPower:      { addr: 0x0875, words: 1, input: true, signed: true, scale: -1, min: -60000, max: 60000 },
  // PV has no single total register (0x0056 looked like one but stayed at 228
  // while production fell — a different quantity), so sum the three phases.
  // Verified against three consecutive IND_PVI cloud samples as production
  // dropped at dusk: cloud phase A 91→80→61 W, these registers 79→73/71→58.
  pvPower:        { addr: 0x0426, words: 3, input: true, signed: true, sum: true, min: -1000, max: 60000 },
  // House load total. Verified by tracking it against the energy balance
  // (PV + grid + battery): it followed 716→722 W while the balance said
  // 716→724 W, where three other same-magnitude candidates (0x0097, 0x08AE,
  // 0x08FD) stayed frozen — so those were static config, this one is live.
  loadPower:      { addr: 0x0879, words: 1, input: true, signed: true, min: -1000, max: 60000 },
};

/**
 * Battery settings that live in the stick's holding registers and can be both
 * read and written locally. Verified end-to-end on 2026-08-22: each value was
 * written over Modbus and the change then showed up in S-Miles (which the app
 * reads back independently), and writing 0 to the charge-power register
 * stopped a running 4 kW forced charge within ten seconds.
 *
 * Powers are stored as percent x10 (250 = 25.0%). The SOC registers are plain
 * percentages — the two scales really do differ.
 *
 * There is no separate "max SOC" register, because there is no separate
 * setting: each mode's reserved SOC IS that limit, and which end it bounds
 * flips with the mode — the floor the battery discharges to in Force Discharge,
 * the ceiling it charges up to in Force Charge. Confirmed by setting Force
 * Charge to 77% / 28%: across the whole 0x1000–0x1300 block exactly two
 * registers moved, 0x10CF → 77 and 0x10D0 → 280.
 *
 * CORRECTED 2026-09-07: the battery mode is NOT cloud-only. It is the first word
 * of the EMS block, 0x10CC, and it is readable and writable. The earlier note
 * here said no register reflected it; that was wrong, and it cost us a lot of
 * guesswork. The code is zero-based — register = mode - 1 — confirmed twice
 * against the cloud (Force Charge 5 read 4, Force Discharge 6 read 5) and by
 * writing 4 into a running Force Discharge, which stopped the battery within
 * seventeen seconds. A cloud mode switch takes about four minutes.
 *
 * Beware when correlating: S-Miles shows default values for modes that were
 * never actually configured, so its screen is not proof of what the inverter
 * holds. Only a value the user demonstrably saved, or one written here and seen
 * to propagate, counts as a reference point.
 */
const SETTING_REGISTERS = {
  maxChargePower:    { addr: 0x10D0, factor: 10, min: 0, max: 100 },
  maxDischargePower: { addr: 0x10D2, factor: 10, min: 0, max: 100 },
};

/**
 * The EMS block: battery mode plus that mode's SOC and power setpoints, in one
 * contiguous run that the inverter expects to be written as a whole with FC16.
 *
 * Word 0 is the mode, zero-based (register = mode - 1). The rest are the
 * per-mode setpoints already mapped individually above; they are listed here
 * because a write has to carry them along unchanged.
 *
 * Writing this is the fast way to change mode: seventeen seconds measured,
 * against roughly four minutes for the cloud. Anything read from it must be
 * validated before being written back — a garbled reply written into this block
 * would reconfigure the battery.
 */
const EMS_BLOCK = { addr: 0x10CC, words: 7 };
const EMS_MODE_OFFSET = 1;              // register 0 == battery mode 1

// Plausible ranges per word, used to reject a garbled read before it is ever
// written back. Order matches the block: mode, self-use SOC, backup SOC,
// force-charge SOC, max charge power (x10), force-discharge SOC,
// max discharge power (x10).
const EMS_BOUNDS = [[0, 8], [0, 100], [0, 100], [0, 100], [0, 1000], [0, 100], [0, 1000]];

/**
 * Device-wide limits, a layer ABOVE the per-mode EMS block.
 *
 * These bind in every battery mode, which is what makes them useful: the
 * per-mode power limits (SETTING_REGISTERS) only govern inside their own forced
 * mode, so neither of them can stop a charge while the station runs
 * Self-Consumption. The maximum SOC can. Measured on live hardware 2026-09-07:
 * charging 2028 W from solar at 74% SOC, writing 55 here dropped the battery to
 * -74 W within nineteen seconds and sent the surplus to the grid; writing 100
 * back resumed charging within twenty. It does not provoke a discharge and does
 * not touch the operating mode, so the inverter keeps covering the house.
 *
 * Addresses confirmed against the community register catalogue for this exact
 * hardware (Maximum SOC 308, Minimum SOC 309) and then verified by write and
 * read-back.
 */
const DEVICE_LIMIT_REGISTERS = {
  maxSoc: { addr: 0x0134, factor: 1, min: 0, max: 100 },
  minSoc: { addr: 0x0135, factor: 1, min: 0, max: 100 },
};

/**
 * Reserve SOC exists once PER BATTERY MODE, and the cloud reports whichever
 * mode is active — which is why a single register appeared to "stop matching"
 * during discovery when the mode had actually changed underneath. Only the two
 * modes seen on real hardware are mapped; any other mode falls back to cloud.
 */
// Self-Consumption has TWO floor registers and the HIGHER one wins. Measured
// both ways on live hardware 2026-09-07, each stopping a discharge within
// nineteen seconds: 0x10CA=65 with 0x10CD=30, and 0x10CD=65 with 0x10CA=30.
//
// They are NOT interchangeable, and 0x10CD is the one that counts:
//   - The S-Miles cloud writes 0x10CD. Watched live: setting Self-Consumption to
//     70 in the app moved 0x10CD from 30 to 70 and left 0x10CA untouched.
//   - 0x10CD also charges the battery back UP to its level (from the grid, at
//     whatever the tariff happens to be); 0x10CA only blocks discharging.
//
// So the FIRST address of each list is the one to write, and any further ones
// are parked at 0 so they can never quietly become the binding floor. Reading
// still takes the maximum of all of them, because something outside this app
// can raise one and the card must show the floor the battery really honours.
const RESERVE_SOC_BY_MODE = {
  1: [0x10CD, 0x10CA],  // Self-Consumption — 0x10CD is the cloud's register
  5: [0x10CF],          // Force Charge — level it charges up to
  // Force Discharge — the floor it sells down to. Verified the same day on a
  // running discharge: mode 6, SOC 53%, selling 2519 W. Writing 65 here stopped
  // it within nineteen seconds; writing 30 back resumed it just as fast.
  6: [0x10D1],
};

/**
 * One kept-open TCP connection to a stick, shared by every device that talks to
 * it.
 *
 * The obvious implementation — open a socket, ask one question, close it — is
 * what this app used to do, and it is why the DTS-WL-G3 looked unreliable. It
 * dislikes rapid reconnects: a probe built that way produced a steady stream of
 * ECONNRESET / CLOSED / TIMEOUT, while the exact same probe over a single
 * kept-open connection answered 12 out of 12 without a single retry.
 *
 * Responses are matched to requests by MBAP transaction id rather than by
 * arrival order, so a late answer to a request that already timed out is
 * dropped instead of being handed to the next caller as if it were its own.
 * That matters here: this stick does sometimes answer a beat behind.
 */
/**
 * Per-module BMS detail, at FC04 0x5600-0x5C00. The cloud does not expose this
 * at all, and the original address sweep missed it because it only probed the
 * first few registers of each page and these pages start with zeros.
 *
 * Each module holds 8 cell voltages (mV) immediately followed by 8 cell
 * temperatures (x0.1 degC). On the reference system four modules sat at
 * 0x56DB, 0x5807, 0x5933 and 0x5A5F — a stride of 0x12C.
 *
 * The addresses are DETECTED by that shape rather than hardcoded, because a
 * different number of modules (or a firmware revision) would shift them, and
 * hardcoding an address that merely fits one installation is how several
 * earlier "findings" in this project turned out to be wrong.
 *
 * Verified structurally: the 8 cells of each module sum to ~26.66 V against an
 * independently measured pack voltage of 26.5 V, and the four modules showed a
 * monotonic thermal gradient (27.8 -> 26.3 degC) as a physical stack would.
 */
const BMS = {
  // Reference layout, tried first and always verified before use.
  knownBase:   0x56DB,
  stride:      0x12C,
  searchFrom:  0x5600,
  searchTo:    0x5C00,
  cellsPerModule: 8,
  cellMinMv:   2500,  // LiFePO4 working range, generous on both sides
  cellMaxMv:   3800,
  tempMinDeci: 100,   // 10.0 degC
  tempMaxDeci: 600,   // 60.0 degC
  maxModules:  16,
};

class ModbusConnection {

  constructor(host, port, log) {
    this.host = host;
    this.port = port;
    this.log  = log || (() => {});
    this._socket     = null;
    this._connecting = null;
    this._buf        = Buffer.alloc(0);
    this._pending    = new Map(); // transaction id → { resolve, reject, expectFc, timer }
    this._tid        = 0;
    this._idleTimer  = null;
    this._connectFailedUntil = 0;
  }

  async request(unitId, pdu, expectFc) {
    const socket = await this._ensure();
    const tid    = (this._tid = (this._tid + 1) & 0xffff);

    const mbap = Buffer.alloc(7);
    mbap.writeUInt16BE(tid, 0);            // transaction id
    mbap.writeUInt16BE(0, 2);              // protocol id = 0
    mbap.writeUInt16BE(pdu.length + 1, 4); // length = unit + pdu
    mbap.writeUInt8(unitId & 0xff, 6);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(tid);
        reject(new Error(`Timeout on ${this.host}:${this.port}`));
      }, TIMEOUT_MS);
      this._pending.set(tid, { resolve, reject, expectFc, timer });
      this._touchIdle();
      socket.write(Buffer.concat([mbap, pdu]), (err) => {
        if (err) {
          clearTimeout(timer);
          this._pending.delete(tid);
          this._drop(err);
          reject(err);
        }
      });
    });
  }

  _ensure() {
    if (this._socket && !this._socket.destroyed) return Promise.resolve(this._socket);
    if (this._connecting) return this._connecting;

    // A stick that is off or unplugged costs a full connect timeout per
    // attempt. Without this, one getData() spent 64s working through six
    // fields; remembering the failure briefly turns that into one timeout for
    // the whole batch, after which it retries normally.
    if (this._connectFailedUntil && Date.now() < this._connectFailedUntil) {
      return Promise.reject(new Error(`${this.host}:${this.port} unreachable (recent connect failure)`));
    }

    this._connecting = new Promise((resolve, reject) => {
      const socket = new net.Socket();
      socket.setNoDelay(true);

      // Cap the connect attempt ourselves. Without this Node waits for the OS
      // TCP timeout — measured at 42s against an unplugged stick, versus the
      // 5s the old socket-per-request code took, because that set the timeout
      // before connecting.
      socket.setTimeout(TIMEOUT_MS);

      const failConnect = (err) => {
        this._connecting = null;
        this._socket = null;
        this._connectFailedUntil = Date.now() + CONNECT_BACKOFF_MS;
        socket.destroy();
        reject(err instanceof Error ? err : new Error(err));
      };
      const onConnectError   = (err) => failConnect(new Error(err.code || err.message));
      const onConnectTimeout = () => failConnect(new Error(`Timeout connecting to ${this.host}:${this.port}`));
      socket.once('error', onConnectError);
      socket.once('timeout', onConnectTimeout);

      socket.connect(this.port, this.host, () => {
        socket.removeListener('error', onConnectError);
        socket.removeListener('timeout', onConnectTimeout);
        // Idle handling is ours (_touchIdle); disable the socket's own timer so
        // it does not tear down a healthy connection between polls.
        socket.setTimeout(0);
        socket.on('error', (err) => this._drop(new Error(err.code || err.message)));
        socket.on('close', () => this._drop(new Error('Connection closed')));
        socket.on('data',  (chunk) => this._onData(chunk));

        this._buf        = Buffer.alloc(0);
        this._socket     = socket;
        this._connecting = null;
        this._touchIdle();
        resolve(socket);
      });
    });
    return this._connecting;
  }

  /** Drain every complete MBAP frame sitting in the buffer. */
  _onData(chunk) {
    this._touchIdle();
    this._buf = Buffer.concat([this._buf, chunk]);

    while (this._buf.length >= 8) {
      const len = this._buf.readUInt16BE(4);   // bytes after the length field
      if (this._buf.length < 6 + len) break;   // frame still incomplete

      const frame = this._buf.slice(0, 6 + len);
      this._buf   = this._buf.slice(6 + len);

      // The length field counts unit id + PDU, so a well-formed frame is at
      // least unit id (1) + function code (1) = 2, i.e. 8 bytes total. A
      // shorter frame means the stick sent something we don't understand, or
      // — worse — this length field is bogus and everything after it in the
      // buffer is misaligned. Either way we can no longer trust the stream,
      // so drop the connection and let the next call reconnect and resync
      // rather than crash on reading a byte that isn't there (seen live:
      // ERR_OUT_OF_RANGE reading offset 7 of a 7-byte frame).
      if (frame.length < 8) {
        this._drop(new Error(`Malformed Modbus frame (length field ${len})`));
        return;
      }

      const tid    = frame.readUInt16BE(0);
      const respFc = frame.readUInt8(7);
      const p      = this._pending.get(tid);
      // No pending entry means a late or duplicate answer: drop it rather than
      // misattribute it to whoever asks next.
      if (!p) continue;
      this._pending.delete(tid);
      clearTimeout(p.timer);

      if (respFc & 0x80) {
        const code = frame.length > 8 ? frame.readUInt8(8) : 0;
        p.reject(new Error(`Modbus exception ${code} (fc ${p.expectFc})`));
      } else if ((respFc & 0x7f) !== p.expectFc) {
        p.reject(new Error(`Function code mismatch: got ${respFc}, expected ${p.expectFc}`));
      } else {
        p.resolve(frame.slice(8)); // PDU payload after unit + fc
      }
    }
  }

  /** Connection lost: fail everything in flight and reconnect on next use. */
  _drop(err) {
    const socket = this._socket;
    this._socket = null;
    this._buf    = Buffer.alloc(0);
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    if (socket) socket.destroy();

    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this._pending.clear();
  }

  /** Close an unused connection instead of holding it open indefinitely. */
  _touchIdle() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      if (this._pending.size) return this._touchIdle();
      if (this._socket) {
        this.log(`[Modbus] closing idle connection to ${this.host}:${this.port}`);
        this._drop(new Error('Idle'));
      }
    }, IDLE_CLOSE_MS);
    // Never let this timer keep the process alive.
    if (this._idleTimer.unref) this._idleTimer.unref();
  }
}

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
    // Transaction ids belong to the shared connection, not to this instance.
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Confirm the stick answers Modbus on the configured unit id.
   * Returns true on any valid Modbus response (data OR exception).
   */
  async isReachable(unitId = this.unitId) {
    // FC04 @0 first: that is what a DTS-WL-G3 answers. The documented control
    // register 0xC001 is not exposed there, so probing it first wasted a full
    // 5s timeout on every reachability check — enough to push the register
    // scan against Homey's 10s API limit. Kept as the fallback for sticks that
    // do implement the documented map.
    for (const [fc, addr] of [[FC.READ_INPUT, 0x0000], [FC.READ_HOLDING, REG.POWER_LIMIT_ALL]]) {
      try {
        await this._request(unitId, fc, addr, 1);
        return true;
      } catch (err) {
        // An exception response still proves the device speaks Modbus.
        if (/Modbus exception/.test(err.message)) return true;
      }
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
   * A chunk that fails is retried rather than left out. Chunks used to come
   * back at the wrong ADDRESS — responses were matched by arrival order, so a
   * late answer was handed to the next request and every address in the scan
   * shifted by one chunk. That is fixed in the transport (responses are matched
   * on transaction id now), and measurements confirm it: ten consecutive scans
   * produced zero shifted results. What remained was chunks dropping out
   * entirely — 2 in 10 — which is what these retries are for.
   *
   * Note this deliberately does NOT double-read to verify. That works for
   * config registers but would reject most of an FC04 scan, where the values
   * are live and genuinely differ between two reads.
   *
   * @param {number} start  first register address
   * @param {number} count  how many registers to read
   * @param {object} [opts] { input, unitId, chunk, tries }
   */
  async scan(start, count, { input = false, unitId = this.unitId, chunk = 32, tries = 3 } = {}) {
    const result = {};
    for (let off = 0; off < count; off += chunk) {
      const qty = Math.min(chunk, count - off);
      for (let attempt = 1; attempt <= tries; attempt++) {
        try {
          const words = await this.readRegisters(start + off, qty, { input, unitId });
          words.forEach((w, i) => {
            const a = start + off + i;
            result['0x' + a.toString(16).toUpperCase().padStart(4, '0')] = w;
          });
          break;
        } catch (err) {
          if (attempt === tries) {
            this.log(`[Modbus] scan ${this._hex(start + off)}..+${qty} failed after ${tries} tries: ${err.message}`);
          } else {
            await this._gap();
          }
        }
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
      out[field] = null;
      // The stick drops requests when something else is talking to it, so give
      // each read a second chance before giving up on the field.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const words = await this.readRegisters(def.addr, def.words || 1, { input: def.input });
          const value = this._decode(words, def);
          if (this._plausible(value, def) && this._plausibleChange(field, value, def)) {
            this._remember(field, value);
            out[field] = value;
            break;
          }
          this.log(`[Modbus] ${field} implausible (${value}) — discarded`);
        } catch (err) {
          if (attempt === 1) this.log(`[Modbus] read ${field} failed: ${err.message}`);
        }
        await this._gap();
      }
      await this._gap();
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

  // ── Battery settings (local read/write) ───────────────────────────────────

  /**
   * Read the locally available battery settings.
   * @param {number|string} activeMode the battery mode the station is in — the
   *        reserve SOC register is mode-specific, so without it that field
   *        stays null and the caller keeps the cloud value.
   * @returns {Promise<{reserveSoc:?number, maxChargePower:?number, maxDischargePower:?number}>}
   */
  async getSettings(activeMode) {
    const out = { reserveSoc: null, maxChargePower: null, maxDischargePower: null };

    for (const [field, def] of Object.entries(SETTING_REGISTERS)) {
      out[field] = await this._readPercent(def);
    }

    const addr = RESERVE_SOC_BY_MODE[Number(activeMode)];
    if (addr !== undefined) {
      out.reserveSoc = await this._readPercent({ addr, factor: 1, min: 0, max: 100 });
    }
    return out;
  }

  /**
   * The battery mode, straight off the stick. Beats the cloud on both freshness
   * and honesty: the cloud value arrives with the five-minute settings refresh,
   * and a stale mode silently changes what a per-mode write MEANS.
   *
   * Returns null rather than guessing when the reply is not trustworthy.
   */
  async getBatteryMode() {
    const words = await this.readRegisters(EMS_BLOCK.addr, EMS_BLOCK.words, { input: false });
    if (!this._emsBlockSane(words)) return null;
    return words[0] + EMS_MODE_OFFSET;
  }

  /**
   * Switch the battery mode locally.
   *
   * Reads the block, replaces only the mode word and writes all seven back,
   * which is how the inverter expects this block to be written. The read is
   * validated first: writing back a garbled reply would rewrite every setpoint
   * of the mode along with it.
   */
  async setBatteryMode(mode) {
    const modeNum = Number(mode);
    const reg = modeNum - EMS_MODE_OFFSET;
    if (!Number.isInteger(modeNum) || reg < EMS_BOUNDS[0][0] || reg > EMS_BOUNDS[0][1]) {
      throw new Error(`Invalid battery mode for the local write: ${mode}`);
    }

    const words = await this.readRegisters(EMS_BLOCK.addr, EMS_BLOCK.words, { input: false });
    if (!this._emsBlockSane(words)) {
      throw new Error('Refusing to write the EMS block: the read-back of its current '
        + 'contents was not plausible, and writing it back would reconfigure the battery.');
    }
    if (words[0] === reg) return modeNum;          // already there, no EEPROM write

    const next = [...words];
    next[0] = reg;
    await this.writeRegisters(EMS_BLOCK.addr, next);

    const check = await this.readRegisters(EMS_BLOCK.addr, EMS_BLOCK.words, { input: false });
    if (!this._emsBlockSane(check) || check[0] !== reg) {
      throw new Error(`Battery mode write not confirmed: wrote ${modeNum}, read back `
        + `${this._emsBlockSane(check) ? check[0] + EMS_MODE_OFFSET : 'an implausible block'}`);
    }
    return modeNum;
  }

  /**
   * Is this reply really the EMS block? The stick answers with nonsense often
   * enough under load — short frames, or one value repeated across the block —
   * that an unvalidated read has repeatedly produced false findings here.
   */
  _emsBlockSane(words) {
    if (!Array.isArray(words) || words.length !== EMS_BLOCK.words) return false;
    if (new Set(words).size === 1) return false;
    return words.every((w, i) => typeof w === 'number'
      && w >= EMS_BOUNDS[i][0] && w <= EMS_BOUNDS[i][1]);
  }

  /**
   * Read both device-wide SOC limits in ONE request. Single-register reads on
   * this stick come back swapped often enough to matter, and these two sit
   * adjacent, so one block read is both cheaper and safer.
   */
  async getDeviceLimits() {
    const { maxSoc, minSoc } = DEVICE_LIMIT_REGISTERS;
    const first = Math.min(maxSoc.addr, minSoc.addr);
    const words = await this.readRegisters(first, 2, { input: false });
    const pick = (def) => {
      const v = words[def.addr - first];
      return (typeof v === 'number' && v >= def.min && v <= def.max) ? v : null;
    };
    return { maxSoc: pick(maxSoc), minSoc: pick(minSoc) };
  }

  /**
   * The charge ceiling that works in every mode. Writing it below the current
   * SOC stops a charge in about twenty seconds; 100 releases it again.
   */
  async setMaxSocLocal(percent) {
    return this._writePercent(DEVICE_LIMIT_REGISTERS.maxSoc, percent);
  }

  /** True when this mode's reserve SOC has a known register. */
  static hasLocalReserveSoc(mode) {
    return RESERVE_SOC_BY_MODE[Number(mode)] !== undefined;
  }

  async setMaxChargePower(percent) {
    return this._writePercent(SETTING_REGISTERS.maxChargePower, percent);
  }

  async setMaxDischargePower(percent) {
    return this._writePercent(SETTING_REGISTERS.maxDischargePower, percent);
  }

  /**
   * Write the reserve SOC of a NAMED battery mode — not necessarily the active
   * one. Each mode keeps its own register, so the write is unambiguous whatever
   * the station is currently doing, which is exactly why the per-mode sliders
   * use this path instead of the cloud (the cloud only ever writes the mode that
   * happens to be active).
   */
  /**
   * Read every mode's reserve SOC in one request.
   *
   * Deliberately one block read instead of a read per register. Single-register
   * reads on the DTS stick come back misaligned often enough to matter: asking
   * for 0x10CA and 0x10CF separately returned each other's values on roughly one
   * pass in two (measured 2026-09-06), and a swapped percentage is
   * indistinguishable from a real one. Requesting the whole span at once turns a
   * misalignment into a shifted reply, which the length check rejects outright.
   */
  async getReserveSocByMode() {
    const addrs = Object.values(RESERVE_SOC_BY_MODE).flat();
    const first = Math.min(...addrs);
    const qty   = Math.max(...addrs) - first + 1;
    const words = await this.readRegisters(first, qty, { input: false });

    const out = {};
    for (const [mode, list] of Object.entries(RESERVE_SOC_BY_MODE)) {
      // The effective floor is the highest of the mode's registers, so that is
      // what to show. Reporting only one would understate what the battery
      // actually honours.
      const values = list
        .map((addr) => words[addr - first])
        .filter((v) => typeof v === 'number' && v >= 0 && v <= 100);
      out[mode] = values.length ? Math.max(...values) : null;
    }
    return out;
  }

  async setReserveSoc(percent, mode) {
    const [primary, ...shadows] = RESERVE_SOC_BY_MODE[Number(mode)] || [];
    if (primary === undefined) {
      throw new Error(`No local reserve-SOC register known for battery mode ${mode}`);
    }
    await this._writePercent({ addr: primary, factor: 1, min: 0, max: 100 }, percent);

    // Park the others at zero so the effective floor is the one just written.
    // Left at some older value they would win whenever they happen to be higher,
    // and the card would show a floor the battery is not using. Only written
    // when they are not already zero — this block sits in EEPROM.
    for (const addr of shadows) {
      const [current] = await this.readRegisters(addr, 1, { input: false });
      if (current !== 0) {
        await this._writePercent({ addr, factor: 1, min: 0, max: 100 }, 0);
      }
    }
    return percent;
  }

  async _readPercent(def) {
    const factor = def.factor || 1;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const [raw] = await this.readRegisters(def.addr, 1, { input: false });
        const value = Math.round(raw / factor);
        if (this._plausible(value, def)) return value;
        this.log(`[Modbus] setting ${this._hex(def.addr)} out of range (${value}) — discarded`);
      } catch (err) {
        if (attempt === 1) this.log(`[Modbus] read setting ${this._hex(def.addr)} failed: ${err.message}`);
      }
      await this._gap();
    }
    return null;
  }

  /**
   * Write a percentage setting and confirm it by reading it back. These writes
   * are persistent in the inverter, so a silently dropped or mangled write
   * would leave a wrong setting behind — the echo alone is not enough proof.
   */
  async _writePercent(def, percent) {
    const pct = Math.round(Number(percent));
    if (!isFinite(pct) || pct < def.min || pct > def.max) {
      throw new Error(`Value out of range: ${percent} (allowed ${def.min}–${def.max})`);
    }
    const raw = pct * (def.factor || 1);
    await this.writeRegisters(def.addr, [raw]);
    await this._gap();
    const [check] = await this.readRegisters(def.addr, 1, { input: false });
    if (check !== raw) {
      throw new Error(`Write to ${this._hex(def.addr)} not confirmed: wrote ${raw}, read back ${check}`);
    }
    this.log(`[Modbus] ${this._hex(def.addr)} ← ${raw} (${pct}%) confirmed`);
    return pct;
  }

  // ── Per-module BMS detail ─────────────────────────────────────────────────

  /**
   * Locate the per-module BMS blocks by their shape. Expensive (it sweeps
   * ~1500 registers), so the caller is expected to cache the result and only
   * re-run it when the layout might have changed.
   *
   * @returns {Promise<number[]>} base address of each module, in order
   */
  async findBmsModules({ hint } = {}) {
    // Fast path: modules sit at a fixed stride, so one confirmed base gives the
    // rest. Costs ~2 reads per module instead of sweeping 1500 registers, which
    // measured at 200s and still missed half the modules because every failed
    // read broke the pattern.
    for (const start of [hint, BMS.knownBase].filter(a => Number.isInteger(a))) {
      const chain = await this._walkBmsFrom(start);
      if (chain.length) {
        this.log(`[Modbus] BMS: ${chain.length} module(s) at ${chain.map(a => this._hex(a)).join(', ')}`);
        return chain;
      }
    }

    // Fallback: the layout moved, so hunt for the first module by shape and
    // then walk the stride from there.
    this.log('[Modbus] BMS: known layout did not verify, searching…');
    for (let addr = BMS.searchFrom; addr < BMS.searchTo - 2 * BMS.cellsPerModule; addr++) {
      if (!(await this._looksLikeBmsModule(addr))) continue;
      const chain = await this._walkBmsFrom(addr);
      if (chain.length) {
        this.log(`[Modbus] BMS: ${chain.length} module(s) at ${chain.map(a => this._hex(a)).join(', ')}`);
        return chain;
      }
    }
    this.log('[Modbus] BMS: no modules found');
    return [];
  }

  /** Follow the fixed stride from a base, keeping every address that verifies. */
  async _walkBmsFrom(base) {
    const found = [];
    for (let i = 0; i < BMS.maxModules; i++) {
      const addr = base + i * BMS.stride;
      if (addr >= BMS.searchTo) break;
      if (await this._looksLikeBmsModule(addr)) found.push(addr);
      else if (found.length) break; // end of the chain
      else return [];               // base itself is wrong
    }
    return found;
  }

  /** 8 plausible cell voltages immediately followed by 8 plausible temperatures. */
  async _looksLikeBmsModule(addr) {
    const n = BMS.cellsPerModule;
    const block = await this._readVerified(addr, 2 * n);
    if (!block) return false;
    for (let i = 0; i < n; i++) {
      if (block[i] < BMS.cellMinMv || block[i] > BMS.cellMaxMv) return false;
    }
    for (let i = n; i < 2 * n; i++) {
      if (block[i] < BMS.tempMinDeci || block[i] > BMS.tempMaxDeci) return false;
    }
    return true;
  }

  /**
   * Read the cells and temperatures of each known module.
   * @param {number[]} bases addresses from findBmsModules()
   */
  async getBmsData(bases) {
    if (!Array.isArray(bases) || !bases.length) return null;
    const n = BMS.cellsPerModule;
    const modules = [];

    for (const base of bases) {
      const cells = await this._readVerified(base, n);
      const temps = await this._readVerified(base + n, n);
      if (!cells || !temps) continue;
      if (!cells.every(v => v >= BMS.cellMinMv && v <= BMS.cellMaxMv)) continue;
      if (!temps.every(v => v >= BMS.tempMinDeci && v <= BMS.tempMaxDeci)) continue;
      modules.push({
        address: this._hex(base),
        cells,                                   // mV
        temps: temps.map(t => Math.round(t) / 10), // degC
      });
    }
    if (!modules.length) return null;

    const allCells = modules.flatMap(m => m.cells);
    const allTemps = modules.flatMap(m => m.temps);
    return {
      modules,
      cellMinMv:  Math.min(...allCells),
      cellMaxMv:  Math.max(...allCells),
      // The health number worth graphing: a rising spread means a weakening cell.
      spreadMv:   Math.max(...allCells) - Math.min(...allCells),
      tempMaxC:   Math.max(...allTemps),
      tempMinC:   Math.min(...allTemps),
    };
  }

  /** Read a block twice and only accept it when both reads agree. */
  async _readVerified(addr, qty) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const a = await this.readRegisters(addr, qty, { input: true }).catch(() => null);
      if (a) {
        await this._gap();
        const b = await this.readRegisters(addr, qty, { input: true }).catch(() => null);
        if (b && a.join() === b.join()) return a;
      }
      await this._gap();
    }
    return null;
  }

  /**
   * Write holding registers with FC16 (write multiple).
   *
   * Deliberately NOT FC06: this stick silently ignores single-register writes.
   * Verified by writing back the value a register already held — no response
   * at all — while an FC03 read of that same address answered fine. FC16
   * returns a proper per-address echo and the write actually lands.
   */
  async writeRegisters(addr, values, { unitId = this.unitId } = {}) {
    return this._enqueue(() => this._send(unitId, this._buildWritePdu(addr, values), FC.WRITE_MULTI));
  }

  _hex(addr) {
    return '0x' + addr.toString(16).toUpperCase().padStart(4, '0');
  }

  // ── Modbus framing ────────────────────────────────────────────────────────

  async _writeCoil(unitId, addr, on) {
    // FC05: value 0xFF00 = ON, 0x0000 = OFF
    return this._request(unitId, FC.WRITE_COIL, addr, on ? 0xFF00 : 0x0000);
  }

  /** Read/write-single PDU: fc + address + one 16-bit value or quantity. */
  _buildPdu(fc, addr, valueOrQty) {
    const pdu = Buffer.alloc(5);
    pdu.writeUInt8(fc, 0);
    pdu.writeUInt16BE(addr, 1);
    pdu.writeUInt16BE(valueOrQty & 0xffff, 3);
    return pdu;
  }

  /** FC16 has a variable-length PDU, so it cannot use _buildPdu. */
  _buildWritePdu(addr, values) {
    const pdu = Buffer.alloc(6 + values.length * 2);
    pdu.writeUInt8(FC.WRITE_MULTI, 0);
    pdu.writeUInt16BE(addr, 1);
    pdu.writeUInt16BE(values.length, 3);
    pdu.writeUInt8(values.length * 2, 5);
    values.forEach((v, i) => pdu.writeUInt16BE(v & 0xffff, 6 + i * 2));
    return pdu;
  }

  /**
   * Serialise every request per stick. The DTS-WL-G3 handles only one
   * conversation at a time: two devices polling it concurrently (which happens
   * as soon as a second HiOne device picks up the same saved gateway IP) makes
   * it reset connections — observed live as a steady stream of ECONNRESET /
   * "Connection closed without response" from both devices at the same
   * millisecond. Queuing per host+port, with a small gap between requests,
   * keeps every caller on the same lane instead of colliding.
   */
  _request(unitId, fc, addr, valueOrQty) {
    return this._enqueue(() => this._send(unitId, this._buildPdu(fc, addr, valueOrQty), fc));
  }

  /** Put one exchange on this stick's shared lane. */
  _enqueue(task) {
    const key  = `${this.host}:${this.port}`;
    const prev = HoymilesModbus._queues.get(key) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        await new Promise(r => setTimeout(r, REQUEST_GAP_MS));
        return task();
      });
    // Store a never-rejecting tail so one failure doesn't poison the chain.
    HoymilesModbus._queues.set(key, next.catch(() => {}));
    return next;
  }

  _send(unitId, pdu, expectFc) {
    return this._connection().request(unitId, pdu, expectFc);
  }

  /** One connection per stick, shared by every device pointing at it. */
  _connection() {
    const key = `${this.host}:${this.port}`;
    let conn = HoymilesModbus._connections.get(key);
    if (!conn) {
      conn = new ModbusConnection(this.host, this.port, this.log);
      HoymilesModbus._connections.set(key, conn);
    }
    return conn;
  }

  /**
   * Reject a value that is inside its valid range but could not have got there
   * from the previous reading in the time that passed. Only applied to fields
   * that declare a maxJump — power and grid figures genuinely do swing hard,
   * state of charge does not.
   */
  _plausibleChange(field, value, def) {
    if (typeof def.maxJump !== 'number') return true;
    const last = this._recent && this._recent[field];
    if (!last) return true;
    // After a long gap a large change is legitimate, so only guard fresh ones.
    if (Date.now() - last.at > SOC_JUMP_WINDOW_MS) return true;
    return Math.abs(value - last.value) <= def.maxJump;
  }

  _remember(field, value) {
    if (!this._recent) this._recent = {};
    this._recent[field] = { value, at: Date.now() };
  }

  /** Reject "no data" (0xFFFF) and misdelivered responses via a sanity range. */
  _plausible(value, def) {
    if (typeof value !== 'number' || !isFinite(value)) return false;
    if (typeof def.min === 'number' && value < def.min) return false;
    if (typeof def.max === 'number' && value > def.max) return false;
    return true;
  }

  _decode(words, def) {
    let raw;
    if (def.sum) {
      // Several quantities are only exposed per phase (e.g. PV power), so add
      // the registers up instead of treating them as one wide integer.
      raw = words.reduce((total, w) => {
        const value = (def.signed && w >= 0x8000) ? w - 0x10000 : w;
        return total + value;
      }, 0);
    } else {
      raw = 0;
      for (const w of words) raw = (raw << 16) | w;
      if (def.signed) {
        const bits = words.length * 16;
        if (raw >= 2 ** (bits - 1)) raw -= 2 ** bits;
      }
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
// One kept-open connection per stick, shared across devices for the same
// reason the queue is: this hardware handles a single conversation at a time.
HoymilesModbus._connections = new Map();

module.exports = HoymilesModbus;
module.exports.REG = REG;
module.exports.FC = FC;
module.exports.BATTERY_REGISTERS = BATTERY_REGISTERS;
module.exports.SETTING_REGISTERS = SETTING_REGISTERS;
module.exports.DEVICE_LIMIT_REGISTERS = DEVICE_LIMIT_REGISTERS;
module.exports.EMS_BLOCK = EMS_BLOCK;
module.exports.RESERVE_SOC_BY_MODE = RESERVE_SOC_BY_MODE;
module.exports.BMS = BMS;
