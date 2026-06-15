'use strict';

/**
 * NetworkScan.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight LAN discovery for Hoymiles data sticks. Sweeps every host in a
 * /24 subnet for the two ports this app speaks:
 *
 *   10081  native protobuf protocol (DTU-Pro / DTU-WLite / older DTS sticks)
 *   502    Modbus TCP              (DTS-G3 / DTU in "Hoymiles Modbus" mode)
 *
 * Each open port is then VERIFIED with the matching protocol so a random
 * service on those ports isn't reported as a gateway:
 *   - 10081 → HoymilesLocal.getGatewayInfo() must return a DTU serial.
 *   - 502   → HoymilesModbus must answer a Modbus read. A stick left in
 *             "Export Management" mode keeps 502 open but stays silent, so a
 *             silent 502 host is still surfaced as an unverified candidate
 *             (the user may need to enable Modbus in the S-Miles Installer app).
 *
 * No external dependency — raw net.Socket probes, matching the rest of the
 * project.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const net = require('net');
const HoymilesLocal  = require('./HoymilesLocal');
const HoymilesModbus = require('./HoymilesModbus');

const NATIVE_PORT      = 10081;
const MODBUS_PORT      = 502;
const PROBE_TIMEOUT_MS = 400;   // per TCP connect attempt
const CONCURRENCY      = 32;    // simultaneous probes

/**
 * Resolve the /24 base ("192.168.8.") from an IP-ish string such as
 * "192.168.8.5:80" or "192.168.8.5". Returns null when no IPv4 is present.
 * @param {string} addr
 * @returns {string|null}
 */
function subnetBaseFromAddress(addr) {
  const m = String(addr || '').match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}/);
  return m ? `${m[1]}.${m[2]}.${m[3]}.` : null;
}

/**
 * TCP connect probe — resolves true if the port accepts a connection within
 * the timeout, false otherwise (timeout, refused, unreachable).
 */
function tcpProbe(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error',   () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * Run async tasks with a bounded concurrency pool (no external dep).
 */
async function pool(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      await worker(items[current]);
    }
  });
  await Promise.all(runners);
}

/**
 * Scan a /24 subnet and return verified/candidate Hoymiles gateways.
 *
 * @param {object}   opts
 * @param {string}   opts.subnetBase  e.g. "192.168.8." (1–254 is appended)
 * @param {Function} [opts.log]
 * @param {Function} [opts.error]
 * @returns {Promise<Array<{ip:string, port:number, protocol:string, verified:boolean, dtuSn:?string}>>}
 */
async function discoverGateways({ subnetBase, log = () => {}, error = () => {} }) {
  if (!subnetBase) throw new Error('No subnet to scan');
  log(`[Scan] Probing ${subnetBase}1-254 on ports ${NATIVE_PORT} and ${MODBUS_PORT}`);

  // 1) Fast port sweep — collect every host with one of the two ports open.
  const probes = [];
  for (let n = 1; n <= 254; n++) {
    const ip = `${subnetBase}${n}`;
    probes.push({ ip, port: NATIVE_PORT });
    probes.push({ ip, port: MODBUS_PORT });
  }
  const open = [];
  await pool(probes, CONCURRENCY, async ({ ip, port }) => {
    if (await tcpProbe(ip, port)) open.push({ ip, port });
  });
  log(`[Scan] ${open.length} open port(s); verifying protocol`);

  // 2) Verify each open port with the matching protocol (sequential — there
  //    are only a handful of hits and the native handshake must not be rushed).
  const found = [];
  for (const { ip, port } of open) {
    if (port === NATIVE_PORT) {
      const local = new HoymilesLocal({ host: ip, port, log, error });
      try {
        const info = await local.getGatewayInfo();
        found.push({ ip, port, protocol: 'native', verified: true, dtuSn: info.dtuSn || null });
        log(`[Scan] ${ip}:${port} → native gateway (DTU ${info.dtuSn || '?'})`);
      } catch (_) {
        log(`[Scan] ${ip}:${port} open but no native handshake — ignoring`);
      }
    } else {
      const modbus = new HoymilesModbus({ host: ip, port, log, error });
      const answers = await modbus.isReachable();
      // A silent 502 host is most likely a stick still in "Export Management"
      // mode — surface it as an unverified candidate rather than dropping it.
      found.push({ ip, port, protocol: 'modbus', verified: answers, dtuSn: null });
      log(`[Scan] ${ip}:${port} → Modbus ${answers ? 'device' : 'port open (unverified)'}`);
    }
  }

  // Verified hits first, native before Modbus, then by IP.
  found.sort((a, b) =>
    (Number(b.verified) - Number(a.verified)) ||
    (a.protocol === b.protocol ? 0 : a.protocol === 'native' ? -1 : 1) ||
    a.ip.localeCompare(b.ip, undefined, { numeric: true }));

  return found;
}

module.exports = { discoverGateways, subnetBaseFromAddress, tcpProbe };
