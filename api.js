'use strict';

const HoymilesApi    = require('./lib/HoymilesApi');
const HoymilesModbus = require('./lib/HoymilesModbus');

// Which measurements the app can read straight off the stick, and which only
// ever come from the cloud. Shown on the settings page so it is clear where
// each value originates. Register details come from the live map, so this
// stays in sync when the map is extended.
const CLOUD_ONLY_FIELDS = [
  { field: 'batteryMode',   label: 'Battery mode' },
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
  pvPower:        'hoymiles_pv_power',
  loadPower:      'hoymiles_load_power',
};

const FIELD_LABELS = {
  batterySoc:     'Battery state of charge',
  batteryPower:   'Battery power',
  batteryVoltage: 'Battery voltage',
  batteryCurrent: 'Battery current (derived from power / voltage)',
  gridPower:      'Grid power',
  pvPower:        'Solar power',
  loadPower:      'Home load power',
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

    // Show the values the device already polled rather than querying the stick
    // again — this stick only handles one conversation at a time, so an extra
    // read here would compete with the running poll.
    const ip = (homey.settings.get('saved_gateway_ip') || '').trim();
    const unitId = Number(homey.settings.get('modbus_unit_id')) || 1;
    let error = null;
    try {
      const devices = homey.drivers.getDriver('hione').getDevices();
      const device = devices[0];
      if (device) {
        for (const row of local) {
          const capability = FIELD_CAPABILITIES[row.field];
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
    return { local, cloudOnly: CLOUD_ONLY_FIELDS, unitId, ip: ip || null, error };
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
    try {
      reachable = await modbus.isReachable();
      const start = Number(body && body.start);
      const count = Number(body && body.count) || 64;
      const input = Boolean(body && body.input);

      if (!isNaN(start)) {
        // Explicit range requested
        registers = await modbus.scan(start, count, { input });
      } else if (reachable) {
        // Default: the three FC04 windows that actually carry live data on a
        // DTS-WL-G3 (battery, BMS + grid detail, grid/PV/load totals). Scanning
        // FC03 0x1000 instead — as this did before — only returns static config.
        //
        // Sized to stay well inside Homey's 10s API timeout. Measured on real
        // hardware: 64-register chunks read all 448 registers in ~4s, while
        // 32-register chunks took 6s AND lost more than half the responses —
        // fewer, larger requests collide with the poll far less.
        for (const [from, length] of [[0x0000, 0x0100], [0x0400, 0x60], [0x0860, 0x60]]) {
          Object.assign(registers, await modbus.scan(from, length, { input: true, chunk: 64 }));
        }
      }
    } finally {
      for (const d of paused) {
        try { d.resumePolling(); } catch (_) { /* device meanwhile removed */ }
      }
    }
    // Annotate the registers the app actually uses, so the dump is readable.
    const known = {};
    for (const [field, def] of Object.entries(HoymilesModbus.BATTERY_REGISTERS || {})) {
      for (let i = 0; i < (def.words || 1); i++) {
        known['0x' + (def.addr + i).toString(16).toUpperCase().padStart(4, '0')] = field;
      }
    }
    return { reachable, registers, known };
  },

};
