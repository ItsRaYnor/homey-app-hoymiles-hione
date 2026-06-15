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
      this.homey.flow.getActionCard('set_reserve_soc'),
      async ({ device, soc }) => device.triggerCapabilityListener('hoymiles_reserve_soc', soc)
    );

    registerListener(
      this.homey.flow.getActionCard('set_peak_shaving'),
      async ({ device, reserve_soc, max_soc, meter_power }) =>
        device.setPeakShaving({ reserveSoc: reserve_soc, maxSoc: max_soc, meterPower: meter_power })
    );

    registerListener(
      this.homey.flow.getActionCard('set_relay'),
      async ({ device, state }) => device.setRelayEnabled(state === 'on')
    );

    registerListener(
      this.homey.flow.getActionCard('set_max_power'),
      async ({ device, power }) => device.setMaxPower(power)
    );

    registerListener(
      this.homey.flow.getActionCard('set_max_soc'),
      async ({ device, soc }) => device.setMaxSoc(soc)
    );

    registerListener(
      this.homey.flow.getActionCard('set_grid_limit'),
      async ({ device, watts }) => device.setGridLimit(watts)
    );

    registerListener(
      this.homey.flow.getActionCard('set_tou_period'),
      async ({ device, charge_from, charge_to, charge_power, discharge_from, discharge_to, discharge_power, charge_soc, discharge_soc }) =>
        device.setTouPeriod({
          chargeFrom: charge_from, chargeTo: charge_to, chargePower: charge_power,
          dischargeFrom: discharge_from, dischargeTo: discharge_to, dischargePower: discharge_power,
          chargeSoc: charge_soc, dischargeSoc: discharge_soc,
        })
    );

    registerListener(
      this.homey.flow.getActionCard('set_power_limit'),
      async ({ device, limit }) => device.setPowerLimit(limit)
    );

    registerListener(
      this.homey.flow.getActionCard('set_inverter_state'),
      async ({ device, state, serial }) => device.setInverterState(serial, state === 'on')
    );

    registerListener(
      this.homey.flow.getConditionCard('battery_mode_is'),
      async ({ device, mode }) => device.getCapabilityValue('hoymiles_battery_mode') === mode
    );

    registerListener(
      this.homey.flow.getConditionCard('battery_charging'),
      async ({ device }) => (device.getCapabilityValue('measure_power') || 0) > 0
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

    // Prefill the IP from a previous successful pairing (still editable)
    session.setHandler('get_saved_gateway_ip', async () => {
      return this.homey.settings.get('saved_gateway_ip') || null;
    });

    // Step 2b: cloud login
    session.setHandler('login', async ({ username, password }) => {
      _email    = username;
      _password = password;
      try {
        await _api.login(_email, _password);
        // Remember for the next pairing session
        this.homey.settings.set('saved_email', _email);
        this.homey.settings.set('saved_password', _password);
        return true;
      } catch (err) {
        this.error('Login failed: ' + err.message);
        return false;
      }
    });

    // Saved-login support: reuse credentials from a previous pairing
    session.setHandler('get_saved_login', async () => {
      const email = this.homey.settings.get('saved_email');
      return email ? { email } : null;
    });

    session.setHandler('login_saved', async () => {
      const email    = this.homey.settings.get('saved_email');
      const password = this.homey.settings.get('saved_password');
      if (!email || !password) return false;
      try {
        await _api.login(email, password);
        _email    = email;
        _password = password;
        return true;
      } catch (err) {
        this.error('Saved login failed: ' + err.message);
        return false;
      }
    });

    session.setHandler('forget_login', async () => {
      this.homey.settings.unset('saved_email');
      this.homey.settings.unset('saved_password');
      return true;
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
          port:  this.homey.settings.get('local_port') || undefined,
          log:   this.log.bind(this),
          error: this.error.bind(this),
        });

        let name = 'HiOne (' + _gatewayIp + ')';
        try {
          const info = await local.getGatewayInfo();
          if (info.dtuSn) name = 'HiOne ' + info.dtuSn;
          // Gateway responded — remember this IP for the next pairing
          this.homey.settings.set('saved_gateway_ip', _gatewayIp);
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
      if (stations.length === 0) {
        throw new Error(this.homey.__('pair.no_stations'));
      }
      // Pairing succeeded — remember the gateway IP for the next pairing
      if (_gatewayIp) this.homey.settings.set('saved_gateway_ip', _gatewayIp);
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
