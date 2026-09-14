'use strict';

const { Driver } = require('homey');
const HoymilesApi   = require('../../lib/HoymilesApi');
const HoymilesLocal = require('../../lib/HoymilesLocal');
const { discoverGateways, subnetBaseFromAddress } = require('../../lib/NetworkScan');

// How far below the charge target the battery has to be before a forced charge
// is worth entering at all.
const CHARGE_NEEDED_MARGIN_PCT = 2;

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

    // Targets whichever mode is active, which is all the cloud endpoint can do.
    // It no longer rides on a capability: the single ambiguous reserve tile was
    // split into one tile per mode, so there is no "the" reserve capability to
    // trigger. Kept as-is for Flows that already use it.
    registerListener(
      this.homey.flow.getActionCard('set_reserve_soc'),
      async ({ device, soc }) => device.setReserveSocActiveMode(soc)
    );

    // Names its target mode, so it addresses that mode's register directly and
    // works while another mode is running. Local only, by nature: the cloud has
    // no way to express "the reserve of a mode that is not active".
    registerListener(
      this.homey.flow.getActionCard('set_reserve_soc_for_mode'),
      async ({ device, mode, soc }) => device.setReserveSocForMode(Number(mode), soc)
    );

    // Binds in every mode, unlike the per-mode power limits, and lands in about
    // twenty seconds where a mode switch takes four minutes.
    registerListener(
      this.homey.flow.getActionCard('set_max_soc_local'),
      async ({ device, limit }) => device.setMaxSocLocal(limit)
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
      this.homey.flow.getActionCard('set_max_charge_power'),
      async ({ device, power }) => device.setMaxChargePower(power)
    );

    registerListener(
      this.homey.flow.getActionCard('set_max_discharge_power'),
      async ({ device, power }) => device.setMaxDischargePower(power)
    );

    registerListener(
      this.homey.flow.getActionCard('set_charge_limit_local'),
      async ({ device, limit }) => device.setChargeLimitLocal(limit)
    );

    registerListener(
      this.homey.flow.getActionCard('set_discharge_limit_local'),
      async ({ device, limit }) => device.setDischargeLimitLocal(limit)
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
      this.homey.flow.getActionCard('report_other_battery'),
      async ({ device, state }) => device.reportOtherBattery(state)
    );

    registerListener(
      this.homey.flow.getConditionCard('other_battery_charging'),
      async ({ device }) => device.otherBatteryIs('charging')
    );

    registerListener(
      this.homey.flow.getConditionCard('other_battery_discharging'),
      async ({ device }) => device.otherBatteryIs('discharging')
    );
    registerListener(
      this.homey.flow.getActionCard('charge_to_plan'),
      async ({ device }) => device.chargeToPlan()
    );
    registerListener(
      this.homey.flow.getActionCard('hold_battery'),
      async ({ device }) => device.holdBatteryHere()
    );
    registerListener(
      this.homey.flow.getConditionCard('battery_mode_is'),
      async ({ device, mode }) => device.getCapabilityValue('hoymiles_battery_mode') === mode
    );

    registerListener(
      this.homey.flow.getConditionCard('battery_charging'),
      async ({ device }) => (device.getCapabilityValue('measure_power') || 0) > 0
    );

    // measure_power: positive = charging, negative = discharging
    registerListener(
      this.homey.flow.getConditionCard('battery_idle'),
      async ({ device, threshold }) => {
        const power = device.getCapabilityValue('measure_power') || 0;
        const limit = Number.isFinite(threshold) ? threshold : 50;
        return Math.abs(power) <= limit;
      }
    );

    registerListener(
      this.homey.flow.getConditionCard('battery_discharging'),
      async ({ device, threshold }) => {
        const power = device.getCapabilityValue('measure_power') || 0;
        const limit = Number.isFinite(threshold) ? threshold : 50;
        return power < -limit;
      }
    );

    registerListener(
      this.homey.flow.getConditionCard('grid_importing'),
      async ({ device }) => (device.getCapabilityValue('hoymiles_grid_power') || 0) > 0
    );

    // The price conditions ask the device for a freshly computed plan, so a
    // Flow that runs on the hour boundary judges the hour it is actually in.
    //
    // No plan THROWS rather than answering false. A false would be read as a
    // real answer, and an inverted card would then turn "we do not know" into
    // "yes" — which is how a restart during the evening peak once parked the
    // battery instead of leaving it alone. Throwing stops the Flow dead, so an
    // outage changes nothing rather than acting on a guess.
    const plan = async (device) => {
      const answer = await device.getPricePlan();
      if (!answer) throw new Error(this.homey.__('errors.no_prices'));
      return answer;
    };
    registerListener(
      this.homey.flow.getConditionCard('price_is_buy_moment'),
      async ({ device }) => Boolean((await plan(device)).buyNow),
    );

    registerListener(
      this.homey.flow.getConditionCard('price_discharge_pays'),
      async ({ device }) => Boolean((await plan(device)).dischargeNow),
    );

    registerListener(
      this.homey.flow.getConditionCard('price_is_sell_moment'),
      async ({ device }) => Boolean((await plan(device)).sellNow),
    );

    registerListener(
      this.homey.flow.getConditionCard('price_is_peak_hour'),
      async ({ device }) => Boolean((await plan(device)).peakNow),
    );
    registerListener(
      this.homey.flow.getConditionCard('price_spread_pays'),
      async ({ device }) => Boolean((await plan(device)).spreadPays),
    );
    // Guards the Force Charge switch. Force Charge charges TO its target and
    // does nothing else: once the target is met the inverter sits idle and
    // ignores the sun, because only Self-Consumption routes surplus PV into the
    // battery. So entering it with a charge that already covers the dear hours
    // does not merely waste a mode write - it parks the battery through a sunny
    // afternoon while the surplus goes to the grid at the bare market price.
    // The margin keeps it out of Force Charge for a percent or two that is not
    // worth the round trip, and matches the write tolerance of charge_to_plan.
    registerListener(
      this.homey.flow.getConditionCard('price_charge_needed'),
      async ({ device }) => {
        const answer = await plan(device);
        if (!Number.isFinite(answer.chargeTarget)) {
          throw new Error(this.homey.__('errors.no_target'));
        }
        const soc = device.getCapabilityValue('measure_battery');
        if (!Number.isFinite(soc)) throw new Error(this.homey.__('errors.no_soc'));
        return soc < answer.chargeTarget - CHARGE_NEEDED_MARGIN_PCT;
      },
    );
    registerListener(
      this.homey.flow.getConditionCard('connection_is_local'),
      // Any transport that reads the battery over the LAN counts as local:
      // 'modbus' / 'modbus_cloud' (Modbus TCP), 'native' (TCP 10081) and the
      // legacy 'local' value still stored on devices from older versions.
      async ({ device }) => ['modbus', 'modbus_cloud', 'native', 'local']
        .includes(device.getCapabilityValue('hoymiles_connection_source'))
    );
  }

  async onPair(session) {
    let _mode          = 'local';   // 'local' | 'cloud' | 'both'
    let _email         = null;
    let _password      = null;
    let _gatewayIp     = null;
    let _localProtocol = 'modbus'; // 'native' | 'modbus' — default Modbus TCP for DTS-WL-G3

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

    // Optional: protocol detected by the network scan for the chosen IP.
    // Pins the new device to that transport. Manual IP entry keeps Modbus TCP.
    session.setHandler('set_local_protocol', async ({ protocol }) => {
      _localProtocol = (protocol === 'native') ? 'native' : 'modbus';
      this.log('Local protocol: ' + _localProtocol);
      return true;
    });

    // Prefill the IP from a previous successful pairing (still editable)
    session.setHandler('get_saved_gateway_ip', async () => {
      return this.homey.settings.get('saved_gateway_ip') || null;
    });

    // Auto-detect: sweep the local /24 for sticks on port 10081 (native) or
    // 502 (Modbus) and verify each hit. Returns the found-device list.
    session.setHandler('scan_network', async () => {
      let base = null;
      try {
        base = subnetBaseFromAddress(await this.homey.cloud.getLocalAddress());
      } catch (err) {
        this.error('Could not read Homey local address: ' + err.message);
      }
      // Fall back to the subnet of a previously paired IP
      if (!base) base = subnetBaseFromAddress(this.homey.settings.get('saved_gateway_ip'));
      if (!base) throw new Error('Could not determine the local subnet to scan');

      const found = await discoverGateways({
        subnetBase: base,
        log:   this.log.bind(this),
        error: this.error.bind(this),
      });
      this.log(`Network scan on ${base}0/24 found ${found.length} device(s)`);
      return found;
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
        // The gateway-info probe uses the native (10081) protocol; skip it for
        // Modbus-only sticks, which would only refuse the connection.
        if (_localProtocol === 'modbus') {
          this.homey.settings.set('saved_gateway_ip', _gatewayIp);
        } else {
          try {
            const info = await local.getGatewayInfo();
            if (info.dtuSn) name = 'HiOne ' + info.dtuSn;
            // Gateway responded — remember this IP for the next pairing
            this.homey.settings.set('saved_gateway_ip', _gatewayIp);
          } catch (_) {
            this.log('Could not fetch gateway info — using IP as name');
          }
        }

        return [{
          name,
          data:     { id: _gatewayIp, stationId: null },
          store:    { email: null, password: null, gatewayIp: _gatewayIp, localProtocol: _localProtocol },
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
        store:    { email: _email, password: _password, gatewayIp: _gatewayIp, localProtocol: _localProtocol },
        settings: { gateway_ip: _gatewayIp || '' },
      }));
    });
  }
}

module.exports = HiOneDriver;
