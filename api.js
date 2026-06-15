'use strict';

const HoymilesApi    = require('./lib/HoymilesApi');
const HoymilesModbus = require('./lib/HoymilesModbus');

module.exports = {

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

    const reachable = await modbus.isReachable();
    const start = Number(body && body.start);
    const count = Number(body && body.count) || 64;
    const input = Boolean(body && body.input);

    let registers = {};
    if (!isNaN(start)) {
      registers = await modbus.scan(start, count, { input });
    }
    return { reachable, registers };
  },

};
