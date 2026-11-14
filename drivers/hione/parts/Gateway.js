'use strict';

/**
 * Keeping hold of the DTS stick: checking it is still at its address,
 * finding it again when it has moved, and reading what it says about itself.
 *
 * Part of HiOneDevice. The methods of this class are copied onto the
 * device's prototype at the end of device.js, so `this` is the device itself
 * and they can call, and be called by, everything else on it. This is one
 * class written in several files to keep each readable - nothing here is a
 * separate object at runtime.
 */

const { discoverGateways, subnetBaseFromAddress } = require('../../../lib/NetworkScan');

// How often to confirm the stick is still at the address we are using, and
// the floor between two subnet sweeps. The check costs one Modbus read when
// the stick is there and one timeout when it is not, so it can be frequent;
// the sweep touches 254 hosts, so it may not be.
const GATEWAY_WATCH_MS      = 15 * 60_000;

const GATEWAY_RESCAN_MIN_MS = 30 * 60_000;

class Gateway {

  /**
   * Keep talking to the stick after DHCP moves it.
   *
   * A lease renewal can hand the stick a new address at any time, and the app
   * then talks to a host that is not there: every local read spends a timeout,
   * the battery mode falls back to the cloud and the power tiles freeze on
   * their last good reading with nothing to say so. Worse, the device settings
   * page - the one place to correct the address - is served by the same busy
   * app, so the correction is exactly what stops working.
   *
   * So the stick gets found instead of asked for. Order: the address in use,
   * then every other address we know of, then a sweep of the local /24. What
   * answers is remembered in the device STORE, which code can write; the
   * setting is left alone, because writing it needs the page that is stuck.
   */
  async _ensureGatewayReachable({ allowScan = true } = {}) {
    if (this._gatewayCheckInFlight) return this._gatewayCheckInFlight;
    this._gatewayCheckInFlight = this._runGatewayCheck({ allowScan })
      .finally(() => { this._gatewayCheckInFlight = null; });
    return this._gatewayCheckInFlight;
  }

  async _runGatewayCheck({ allowScan }) {
    // A cloud-only device has no stick to find, and the stick this Homey can
    // see belongs to another installation. Never probe or sweep on its behalf.
    if (this._isCloudOnly()) return null;
    const known = this._gatewayHost
      || this.getSetting('gateway_ip')
      || this.getStoreValue('gatewayIp')
      || this.homey.settings.get('saved_gateway_ip');
    if (!known) return null;

    if (await this._hybrid.probeLocal().catch(() => false)) {
      // Remember where it actually answered, so the next restart can fall
      // straight back here instead of sweeping again.
      if (this._gatewayHost && this.getStoreValue('gatewayIpVerified') !== this._gatewayHost) {
        await this.setStoreValue('gatewayIpVerified', this._gatewayHost).catch(() => {});
      }
      return this._gatewayHost;
    }

    const tried = new Set([this._gatewayHost].filter(Boolean));
    const candidates = [
      this.getStoreValue('gatewayIpVerified'),
      this.getSetting('gateway_ip'),
      this.getStoreValue('gatewayIp'),
      this.homey.settings.get('saved_gateway_ip'),
    ].filter((ip) => ip && !tried.has(ip));

    for (const ip of candidates) {
      if (tried.has(ip)) continue;
      tried.add(ip);
      this.log('Gateway silent at ' + (this._gatewayHost || '?') + ' - trying ' + ip);
      if (await this._adoptGateway(ip)) return ip;
    }

    if (!allowScan) return null;
    if (Date.now() - (this._gatewayScanAt || 0) < GATEWAY_RESCAN_MIN_MS) return null;
    this._gatewayScanAt = Date.now();

    let base = null;
    try {
      base = subnetBaseFromAddress(await this.homey.cloud.getLocalAddress());
    } catch (err) {
      this.log('Could not read Homey local address: ' + err.message);
    }
    if (!base) base = subnetBaseFromAddress(known);
    if (!base) return null;

    this.log('Gateway not on any known address - sweeping ' + base + '0/24');
    let found = [];
    try {
      found = await discoverGateways({
        subnetBase: base,
        log:   (...args) => this.log(...args),
        error: (...args) => this.error(...args),
      });
    } catch (err) {
      this.error('Gateway sweep failed: ' + err.message);
      return null;
    }

    // Only a stick that actually answered its protocol - an open port alone is
    // a candidate, not a gateway, and adopting one would swap a dead address
    // for a silent one.
    for (const hit of found) {
      if (!hit.verified || tried.has(hit.ip)) continue;
      tried.add(hit.ip);
      if (await this._adoptGateway(hit.ip)) {
        await this._notifyGatewayMoved(hit.ip);
        return hit.ip;
      }
    }
    this.log('Sweep found no gateway that answers');
    return null;
  }

  /** Point the connection at `ip`, and keep it only if the stick answers there. */
  async _adoptGateway(ip) {
    const previous = this._gatewayHost;
    this._createHybrid(ip);
    if (!await this._hybrid.probeLocal().catch(() => false)) {
      this._createHybrid();            // back to whatever was configured
      return false;
    }
    this._gatewayOverride = ip;
    this.log('Gateway answers at ' + ip + ' (was ' + (previous || 'unset') + ')');
    await this.setStoreValue('gatewayIpVerified', ip).catch(() => {});
    this.homey.settings.set('saved_gateway_ip', ip);
    return true;
  }

  async _notifyGatewayMoved(ip) {
    try {
      await this.homey.notifications.createNotification({
        // Homey's __() does not substitute tokens, so do it here.
        excerpt: String(this.homey.__('errors.gateway_moved')).replace('{{ip}}', ip),
      });
    } catch (err) {
      this.error('Could not raise the gateway notification: ' + err.message);
    }
  }

  _startGatewayWatch() {
    if (this._gatewayWatch) this.homey.clearInterval(this._gatewayWatch);
    this._gatewayWatch = this.homey.setInterval(() => {
      this._ensureGatewayReachable().catch(() => {});
    }, GATEWAY_WATCH_MS);
  }

  async _fetchGatewayInfo() {
    try {
      const info = await this._hybrid.getGatewayInfo();
      if (!info) return;
      const updates = {};
      if (info.dtuSn)       updates.dtu_serial       = info.dtuSn;
      if (info.softwareVer) updates.firmware_version  = info.softwareVer;
      if (info.deviceVer)   updates.hardware_version  = info.deviceVer;
      if (info.model)       updates.gateway_model     = info.model;
      if (info.devices && info.devices.length) {
        updates.system_devices = this._formatDeviceList(info.devices);
      }
      if (Object.keys(updates).length > 0) {
        await this.setSettings(updates);
        this.log('Gateway info updated: ' + JSON.stringify(updates));
      }
    } catch (err) {
      this.log('Could not fetch gateway info: ' + err.message);
    }
  }

  _formatDeviceList(devices) {
    // One block per device so every field is visible and the SN can be copied.
    // The textarea setting renders the line breaks and is selectable/copyable.
    return devices.map((d) => {
      const header = [d.type || 'Device', d.status, d.gen].filter(Boolean).join(' · ');
      const lines  = [header];
      const add = (label, value) => { if (value) lines.push(`  ${label}: ${value}`); };
      add('SN', d.serial);
      add('Model', d.model);
      add('Firmware', d.softwareVer);
      add('Hardware', d.hardwareVer);
      return lines.join('\n');
    }).join('\n\n');
  }

}

module.exports = Gateway;
