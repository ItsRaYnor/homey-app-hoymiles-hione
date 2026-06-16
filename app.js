'use strict';

const { App } = require('homey');
const HoymilesApi = require('./lib/HoymilesApi');

class HoymilesHiOneApp extends App {

  async onInit() {
    this.log('Hoymiles HiOne app started');

    // One shared API instance per app; drivers can access via this.homey.app.api
    this.api = new HoymilesApi({
      log:   (...args) => this.log(...args),
      error: (...args) => this.error(...args),
    });

    // Flow action/condition run listeners are registered in the driver
    // (drivers/hione/driver.js) — registering them here too would shadow the
    // driver's correct handlers (the app's onInit runs first), which caused
    // "device.setBatteryMode is not a function" on set_battery_mode.
  }

}

module.exports = HoymilesHiOneApp;
