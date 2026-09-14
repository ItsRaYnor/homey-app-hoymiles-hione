'use strict';

const net            = require('net');
const HoymilesApi    = require('./lib/HoymilesApi');
const HoymilesModbus = require('./lib/HoymilesModbus');

// Ports the two local protocols need. A DTS-WL-G3 only opens 502: a full probe
// of 35 common ports found nothing else, 10081 included. Offering the native
// protocol there sends people hunting for a fault that is really a missing
// service, so the settings page checks and says so.
const PROTOCOL_PORTS = { modbus: 502, native: 10081 };
const PORT_PROBE_MS  = 1500;

// Which measurements the app can read straight off the stick, and which only
// ever come from the cloud. Shown on the settings page so it is clear where
// each value originates. Register details come from the live map, so this
// stays in sync when the map is extended.
// Windows the register scan covers: [start, length, isInputRegister].
// The FC03 entry is the settings block — without it the scan cannot show the
// registers the app writes to.
const SCAN_WINDOWS = [
  [0x0000, 0x0100, true],
  [0x0400, 0x0060, true],
  [0x0860, 0x0060, true],
  // Device-wide limits: maximum and minimum SOC, battery power caps, export
  // limit. A layer above the per-mode block — these bind in every battery mode.
  [0x0100, 0x0060, false],
  [0x10C0, 0x0040, false],
];
// FC03 and FC04 addresses can collide, so holding registers carry a marker.
const FC03_PREFIX = 'FC03 ';

const CLOUD_ONLY_FIELDS = [
  // The battery mode used to sit here. It is the first word of the EMS block and
  // is read and written locally since v1.1.2 — see the local table below.
  { field: 'maxSoc',        label: 'Max charge level (per mode, cloud only)' },
  { field: 'dailyEnergy',   label: 'Energy today / month / year / total' },
  { field: 'batteryInEnergy',  label: 'Battery charged / discharged energy' },
  { field: 'co2Reduction',  label: 'CO2 reduction' },
  { field: 'profitToday',   label: 'EPS savings' },
];

// Which device capability holds each Modbus field, so the settings table can
// show the values the running poll already fetched instead of querying the
// stick a second time.
const FIELD_CAPABILITIES = {
  batterySoc:     'measure_battery',
  batteryPower:   'measure_power',
  batteryVoltage: 'measure_voltage',
  batteryCurrent: 'measure_current',
  gridPower:      'hoymiles_grid_power',
  pvPower:        'hoymiles_smartport_power',
  loadPower:      'hoymiles_load_power',
  // Settings that are read (and written) locally as well
  maxChargePower:    'hoymiles_max_charge_power',
  maxDischargePower: 'hoymiles_max_discharge_power',
};

// The reserved SOC has one register per battery mode, each with its own tile.
// Derived from the same map the reads and writes use, so this table cannot
// drift from the code.
const RESERVE_SOC_MODES = {
  1: { label: 'Self-Consumption', capability: 'hoymiles_reserve_soc_selfuse' },
  5: { label: 'Force Charge',     capability: 'hoymiles_reserve_soc_forcecharge' },
  6: { label: 'Force Discharge', capability: 'hoymiles_reserve_soc_forcedischarge' },
};
const reserveLabel = (mode) =>
  'Reserved SOC: ' + ((RESERVE_SOC_MODES[mode] || {}).label || 'mode ' + mode);

// Names for the register scan. Everything derived from the live maps above stays
// in step with the code; the rest is spelled out here.
//
// 0x10CD is named by the reserve map above, not here: it is the register the
// cloud itself writes for Self-Consumption, measured by setting the value in
// S-Miles and reading it back. 0x10CA holds a second Self-Consumption floor and
// the inverter honours whichever is higher, so both appear under that name.
const EXTRA_SCAN_NAMES = {
  0x10CC: 'Battery mode (register = mode - 1)',
  0x10CE: 'EMS backup SOC (catalogue name, unverified)',
  0x0132: 'Battery max charge power (all modes, unverified scale)',
  0x0133: 'Battery max discharge power (all modes, unverified scale)',
  0x0136: 'Low SOC grid charge power',
  0x0137: 'SOC start charge from grid',
  0x0103: 'Maximum export power limit',
};

const FIELD_LABELS = {
  batterySoc:     'Battery state of charge',
  batteryPower:   'Battery power',
  batteryVoltage: 'Battery voltage',
  batteryCurrent: 'Battery current (derived from power / voltage)',
  gridPower:      'Grid power',
  pvPower:        'Smart port power (sum of the three phase registers)',
  loadPower:      'Home load power',
  // The mode belongs in the name. Neither limit does anything outside its own
  // forced mode — a battery once gained 22 SOC points in 85 minutes with the
  // charge limit sitting at 0, because the station was in Self-Consumption.
  maxChargePower:    'Max charge power (Force Charge only)',
  maxDischargePower: 'Max discharge power (Force Discharge only)',
};

module.exports = {

  /**
   * Report which measurements are read locally over Modbus (with the register
   * they come from) and which are cloud-only. Used by the settings page.
   */
  async dataSources({ homey }) {
    const map = HoymilesModbus.BATTERY_REGISTERS || {};
    const local = Object.entries(map).map(([field, def]) => ({
      field,
      label:    FIELD_LABELS[field] || field,
      register: '0x' + def.addr.toString(16).toUpperCase().padStart(4, '0')
        + ((def.words || 1) > 1 ? '+' + ((def.words || 1) - 1) : ''),
      fc:       def.input ? 'FC04' : 'FC03',
      scale:    def.sum ? 'sum' : (def.scale === -1 ? '×-1' : (def.scale && def.scale !== 1 ? '×' + def.scale : '')),
      value:    null,
    }));
    local.push({
      field: 'batteryCurrent', label: FIELD_LABELS.batteryCurrent,
      register: '—', fc: 'berekend', scale: 'P / U', value: null,
    });

    // Settings that are read locally too — and written locally where that is
    // exactly equivalent to the cloud call.
    const hex = (a) => '0x' + a.toString(16).toUpperCase().padStart(4, '0');

    // The battery mode: first word of the EMS block, zero-based (register =
    // mode - 1). Read on every poll and written locally, which is seconds
    // instead of the roughly four minutes a cloud mode switch takes.
    local.push({
      field: 'batteryMode',
      label: 'Battery mode (register = mode - 1)',
      register: hex((HoymilesModbus.EMS_BLOCK || {}).addr || 0x10CC),
      fc: 'FC03', scale: '', value: null,
      capability: 'hoymiles_battery_mode',
    });

    // Device-wide SOC window. Unlike the per-mode settings below these bind in
    // EVERY battery mode, which is what makes the maximum usable as a fast brake
    // on charging: written below the current SOC it stops a charge in about
    // twenty seconds, whatever mode the station is in.
    for (const [field, def] of Object.entries(HoymilesModbus.DEVICE_LIMIT_REGISTERS || {})) {
      local.push({
        field,
        label: field === 'maxSoc' ? 'Charge ceiling (all modes)' : 'Discharge floor (all modes)',
        register: hex(def.addr), fc: 'FC03', scale: '', value: null,
        capability: field === 'maxSoc' ? 'hoymiles_max_soc_local' : 'hoymiles_min_soc_local_value',
      });
    }

    for (const [field, def] of Object.entries(HoymilesModbus.SETTING_REGISTERS || {})) {
      local.push({
        field,
        label:    FIELD_LABELS[field] || field,
        register: hex(def.addr),
        fc:       'FC03',
        scale:    def.factor && def.factor !== 1 ? '÷' + def.factor : '',
        value:    null,
      });
    }

    // Show the values the device already polled rather than querying the stick
    // again — this stick only handles one conversation at a time, so an extra
    // read here would compete with the running poll.
    const ip = (homey.settings.get('saved_gateway_ip') || '').trim();
    const unitId = Number(homey.settings.get('modbus_unit_id')) || 1;
    let error = null;
    const cloudOnly = CLOUD_ONLY_FIELDS.slice();
    try {
      const devices = homey.drivers.getDriver('hione').getDevices();
      const device = devices[0];
      if (device) {
        // Every mode's reserved SOC, each next to the register it comes from.
        // This used to show one row for whichever mode was thought to be active,
        // which hid the fact that the other register exists and holds a
        // different number — and picked the wrong one whenever that idea of the
        // active mode was stale.
        for (const [mode, list] of Object.entries(HoymilesModbus.RESERVE_SOC_BY_MODE || {})) {
          const known = RESERVE_SOC_MODES[mode] || {};
          local.push({
            field: 'reserveSoc.' + mode,
            label: reserveLabel(mode),
            // Self-Consumption has two of them and the higher one wins, so show
            // both addresses rather than pretend there is one.
            register: [].concat(list).map(hex).join(' + '),
            fc: 'FC03', scale: '', value: null,
            capability: known.capability,
          });
        }

        for (const row of local) {
          const capability = row.capability || FIELD_CAPABILITIES[row.field];
          if (capability && device.hasCapability(capability)) {
            row.value = device.getCapabilityValue(capability);
          }
        }
      } else {
        error = 'No HiOne device added yet';
      }
    } catch (err) {
      error = err.message;
    }
    return { local, cloudOnly, unitId, ip: ip || null, error };
  },

  /**
   * Which local protocols this gateway can actually serve.
   *
   * A plain TCP connect, not a protocol handshake: a closed port is the honest
   * answer to "can this ever work", and it separates "wrong protocol chosen"
   * from "right protocol, something else is broken".
   */
  async checkPorts({ homey, body }) {
    const ip = (body && body.ip || homey.settings.get('saved_gateway_ip') || '').trim();
    if (!ip) throw new Error('No gateway IP set');

    const probe = (port) => new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const done = (open) => { if (settled) return; settled = true; socket.destroy(); resolve(open); };
      socket.setTimeout(PORT_PROBE_MS);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error',   () => done(false));
      socket.connect(port, ip);
    });

    const out = { ip };
    for (const [name, port] of Object.entries(PROTOCOL_PORTS)) {
      out[name] = { port, open: await probe(port) };
    }
    return out;
  },

  /**
   * Per-module cell voltages and temperatures, read on request.
   *
   * Deliberately not polled: 32 readings are for looking at when you want them,
   * not for the device card. Goes through the device so it shares the stick's
   * request queue instead of opening a competing conversation.
   */
  /**
   * The day's price curve for the settings page. Comes from the device so it
   * uses that device's own wear and margin settings — the same numbers the
   * Flow conditions judge on, not a second opinion.
   */
  async dayPrices({ homey }) {
    let device;
    try {
      device = homey.drivers.getDriver('hione').getDevices()[0];
    } catch (err) {
      throw new Error('Could not reach the HiOne device: ' + err.message);
    }
    if (!device) throw new Error('No HiOne device added yet');
    if (typeof device.getPriceCurve !== 'function') {
      throw new Error('Device is still starting up — try again in a moment');
    }

    const curve = await device.getPriceCurve();
    if (!curve) throw new Error('No prices available');
    return curve;
  },
  async bmsDetail({ homey }) {
    let device;
    try {
      device = homey.drivers.getDriver('hione').getDevices()[0];
    } catch (err) {
      throw new Error('Could not reach the HiOne device: ' + err.message);
    }
    if (!device) throw new Error('No HiOne device added yet');
    if (!device._hybrid) throw new Error('Device is still starting up — try again in a moment');

    const hint = device.getStoreValue('bms_base');
    const bms = await device._hybrid.getBmsData(typeof hint === 'number' ? hint : undefined);
    if (!bms) throw new Error('No cell data — this needs a working local Modbus connection');
    return bms;
  },

  /**
   * Verify S-Miles Cloud credentials and store them for pairing.
   * Called from the app settings page.
   */
  async testLogin({ homey, body }) {
    const email    = (body && body.email    || '').trim();
    const password = (body && body.password || '');
    if (!email || !password) throw new Error('Email and password are required');

    const api = new HoymilesApi({
      log:     (...args) => homey.app.log(...args),
      error:   (...args) => homey.app.error(...args),
      baseUrl: homey.settings.get('cloud_api_url') || undefined,
    });

    await api.login(email, password); // throws with details on failure

    homey.settings.set('saved_email', email);
    homey.settings.set('saved_password', password);
    return { email };
  },

  /**
   * Forget the stored S-Miles Cloud account.
   */
  async forgetLogin({ homey }) {
    homey.settings.unset('saved_email');
    homey.settings.unset('saved_password');
    return true;
  },

  /**
   * Diagnostics: log in with the saved/given account and report which battery
   * modes the station actually supports, the current mode + reserve SOC, the
   * raw mode payloads, and the station setting rules. Use this to see which
   * modes are real vs. which the app exposes.
   * Body: { stationId? }  (defaults to the first station on the account)
   */
  async getDiagnostics({ homey, body }) {
    const email    = homey.settings.get('saved_email');
    const password = homey.settings.get('saved_password');
    if (!email || !password) throw new Error('No saved S-Miles account — log in on this page first');

    const api = new HoymilesApi({
      log:     (...a) => homey.app.log(...a),
      error:   (...a) => homey.app.error(...a),
      baseUrl: homey.settings.get('cloud_api_url') || undefined,
    });
    await api.login(email, password);

    const stations = await api.getStations();
    let stationId = body && body.stationId;
    if (!stationId) stationId = stations.length ? stations[0].id : null;
    if (!stationId) return { stations, station: null };

    const settings = await api.getBatterySettings(stationId);
    const rules    = await api.getSettingRules(stationId);
    const labels   = HoymilesApi.BATTERY_MODES;

    const available = (settings && settings.availableModes || []).map(id => ({
      id, name: labels[id] || ('Mode ' + id),
    }));

    // Also write the result to the app log so it can be read without copying
    // from the Homey app UI.
    const log = (...a) => homey.app.log('[Diagnostics]', ...a);
    log('stations:', JSON.stringify(stations));
    log('stationId:', stationId);
    log('currentMode:', settings ? settings.mode : null,
        '=', settings ? (labels[Number(settings.mode)] || '?') : null);
    log('reserveSoc:', settings ? settings.reserveSoc : null);
    log('availableModes:', JSON.stringify(available));
    log('modeData:', JSON.stringify(settings ? settings.modeData : null));
    log('settingRules:', JSON.stringify(rules));

    return {
      stations,
      stationId,
      currentMode: settings ? Number(settings.mode) : null,
      currentModeName: settings ? (labels[Number(settings.mode)] || ('Mode ' + settings.mode)) : null,
      reserveSoc: settings ? settings.reserveSoc : null,
      availableModes: available,
      allKnownModes: Object.entries(labels).map(([id, name]) => ({ id: Number(id), name })),
      modeData: settings ? settings.modeData : null,
      settingRules: rules,
    };
  },

  /**
   * Probe the gateway over Modbus TCP and scan a register range.
   * Used to discover the HiOne hybrid battery registers from the settings page.
   * Body: { ip, port, unitId, start, count, input }
   */
  async scanModbus({ homey, body }) {
    const ip = (body && body.ip || homey.settings.get('saved_gateway_ip') || '').trim();
    if (!ip) throw new Error('No gateway IP set');

    const modbus = new HoymilesModbus({
      host:   ip,
      port:   Number(body && body.port) || Number(homey.settings.get('local_port')) || 502,
      unitId: Number(body && body.unitId) || Number(homey.settings.get('modbus_unit_id')) || 1,
      log:    (...a) => homey.app.log(...a),
      error:  (...a) => homey.app.error(...a),
    });

    // Failsafe: pause every device's polling while the scan runs — the stick
    // handles one conversation at a time, and a poll racing the scan produces
    // timeouts and misdelivered responses on both sides.
    let paused = [];
    try {
      paused = homey.drivers.getDriver('hione').getDevices()
        .filter(d => typeof d.pausePolling === 'function');
      for (const d of paused) d.pausePolling();
    } catch (_) { /* no devices yet */ }

    let registers = {};
    let reachable = false;
    let expected  = 0;
    try {
      reachable = await modbus.isReachable();
      const start = Number(body && body.start);
      const count = Number(body && body.count) || 64;
      const input = Boolean(body && body.input);

      if (!isNaN(start)) {
        // Explicit range requested — tag holding registers the same way the
        // default windows do, so the labels below still line up.
        expected = count;
        const part = await modbus.scan(start, count, { input });
        for (const [addr, value] of Object.entries(part)) {
          registers[input ? addr : FC03_PREFIX + addr] = value;
        }
      } else if (reachable) {
        // Three FC04 windows carry the live data on a DTS-WL-G3 (battery,
        // BMS + grid detail, grid/PV/load totals), and one FC03 window holds
        // the settings the app reads and writes. Both are needed: scanning
        // only FC03 0x1000 — as this did originally — returns static config,
        // while scanning only FC04 leaves out every register the app writes to.
        //
        // Sized to stay well inside Homey's 10s API timeout. Measured on real
        // hardware: 64-register chunks read all 448 registers in ~4s, while
        // 32-register chunks took 6s AND lost more than half the responses —
        // fewer, larger requests collide with the poll far less.
        for (const [from, length, isInput] of SCAN_WINDOWS) {
          expected += length;
          const part = await modbus.scan(from, length, { input: isInput, chunk: 64 });
          // FC03 and FC04 are separate address spaces, so an address alone is
          // ambiguous. Tag the holding registers to keep the dump honest.
          for (const [addr, value] of Object.entries(part)) {
            registers[isInput ? addr : FC03_PREFIX + addr] = value;
          }
        }
      }
    } finally {
      for (const d of paused) {
        try { d.resumePolling(); } catch (_) { /* device meanwhile removed */ }
      }
    }
    // Annotate every register the app actually uses, so the dump is readable:
    // the live measurements, the two power limits, and the reserved SOC of
    // each battery mode that has one.
    const toHex = (a) => '0x' + a.toString(16).toUpperCase().padStart(4, '0');
    const known = {};
    for (const [field, def] of Object.entries(HoymilesModbus.BATTERY_REGISTERS || {})) {
      for (let i = 0; i < (def.words || 1); i++) known[toHex(def.addr + i)] = field;
    }
    for (const [field, def] of Object.entries(HoymilesModbus.SETTING_REGISTERS || {})) {
      known[FC03_PREFIX + toHex(def.addr)] = FIELD_LABELS[field] || field;
    }
    for (const [mode, list] of Object.entries(HoymilesModbus.RESERVE_SOC_BY_MODE || {})) {
      for (const addr of [].concat(list)) known[FC03_PREFIX + toHex(addr)] = reserveLabel(mode);
    }
    for (const [field, def] of Object.entries(HoymilesModbus.DEVICE_LIMIT_REGISTERS || {})) {
      known[FC03_PREFIX + toHex(def.addr)] =
        field === 'maxSoc' ? 'Charge ceiling (all modes)' : 'Discharge floor (all modes)';
    }
    for (const [addr, name] of Object.entries(EXTRA_SCAN_NAMES)) {
      known[FC03_PREFIX + toHex(Number(addr))] = name;
    }
    // Report gaps rather than letting a dropped chunk pass as "this range is
    // empty". Addresses themselves are trustworthy now — responses are matched
    // on transaction id, so a chunk either arrives correctly or not at all.
    const missing = Math.max(0, expected - Object.keys(registers).length);
    return { reachable, registers, known, missing };
  },

};
