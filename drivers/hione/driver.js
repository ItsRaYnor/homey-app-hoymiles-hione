'use strict';

const { Driver } = require('homey');
const HoymilesApi   = require('../../lib/HoymilesApi');
const HoymilesLocal = require('../../lib/HoymilesLocal');

class HiOneDriver extends Driver {

  async onInit() {
    this.log('HiOne driver initialised');

    const registerListener = (card, listener) => {
      if (!card._runListener) {
        card.registerRunListener(listener);
      }
    };

    registerListener(
      this.homey.flow.getActionCard('set_battery_mode'),
      async ({ device, mode }) => device.triggerCapabilityListener('hoymiles_battery_mode', mode)
    );

    registerListener(
      this.homey.flow.getConditionCard('battery_mode_is'),
      async ({ device, mode }) => device.getCapabilityValue('hoymiles_battery_mode') === mode
    );

    registerListener(
      this.homey.flow.getConditionCard('battery_charging'),
      async ({ device }) => (device.getCapabilityValue('hoymiles_battery_power') || 0) > 0
    );

    registerListener(
      this.homey.flow.getConditionCard('grid_importing'),
      async ({ device }) => (device.getCapabilityValue('hoymiles_grid_power') || 0) > 0
    );

    registerListener(
      this.homey.flow.getConditionCard('connection_is_local'),
      async ({ device }) => device.getCapabilityValue('hoymiles_connection_source') === 'local'
    );
  }

  async onPair(session) {
    let _mode      = 'local';   // 'local' | 'cloud' | 'both'
    let _email     = null;
    let _password  = null;
    let _gatewayIp = null;

    const _api = new HoymilesApi({
      log:     this.log.bind(this),
      error:   this.error.bind(this),
      baseUrl: this.homey.settings.get('cloud_api_url') || undefined,
    });

    // Step 1: user picks connection mode
    session.setHandler('set_connection_mode', async ({ mode }) => {
      _mode = mode;
      this.log('Connection mode: ' + mode);
      return true;
    });

    // Step 2a: local IP
    session.setHandler('set_gateway_ip', async ({ ip }) => {
      _gatewayIp = ip || null;
      this.log('Gateway IP: ' + (_gatewayIp || 'none'));
      return true;
    });

    // Step 2b: cloud login
    session.setHandler('login', async ({ username, password }) => {
      _email    = username;
      _password = password;
      try {
        await _api.login(_email, _password);
        return true;
      } catch (err) {
        this.error('Login failed: ' + err.message);
        return false;
      }
    });

    // Let pair views query the chosen connection mode
    session.setHandler('get_connection_mode', async () => _mode);

    // Final step: build device list
    session.setHandler('list_devices', async () => {
      // LOCAL-ONLY: probe the gateway and create a single device
      if (_mode === 'local') {
        if (!_gatewayIp) throw new Error('No IP address provided');

        const local = new HoymilesLocal({
          host:  _gatewayIp,
          log:   this.log.bind(this),
          error: this.error.bind(this),
        });

        let name = 'HiOne (' + _gatewayIp + ')';
        try {
          const info = await local.getGatewayInfo();
          if (info.dtuSn) name = 'HiOne ' + info.dtuSn;
        } catch (_) {
          this.log('Could not fetch gateway info — using IP as name');
        }

        return [{
          name,
          data:     { id: _gatewayIp, stationId: null },
          store:    { email: null, password: null, gatewayIp: _gatewayIp },
          settings: { gateway_ip: _gatewayIp },
        }];
      }

      // CLOUD or BOTH: fetch stations from S-Miles Cloud
      const stations = await _api.getStations();
      return stations.map(s => ({
        name:     s.name,
        data:     { id: s.id, stationId: s.id },
        store:    { email: _email, password: _password, gatewayIp: _gatewayIp },
        settings: { gateway_ip: _gatewayIp || '' },
      }));
    });
  }
}

module.exports = HiOneDriver;
