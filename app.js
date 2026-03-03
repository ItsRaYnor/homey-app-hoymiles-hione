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

    // Register Flow action: set_battery_mode
    this.homey.flow
      .getActionCard('set_battery_mode')
      .registerRunListener(async ({ device, mode }) => {
        return device.setBatteryMode(mode);
      });

    // Register Flow condition: battery_mode_is
    this.homey.flow
      .getConditionCard('battery_mode_is')
      .registerRunListener(async ({ device, mode }) => {
        return device.getCapabilityValue('hoymiles_battery_mode') === String(mode);
      });

    // Register Flow condition: battery_charging
    this.homey.flow
      .getConditionCard('battery_charging')
      .registerRunListener(async ({ device }) => {
        const batteryPower = device.getCapabilityValue('hoymiles_battery_power') ?? 0;
        return batteryPower > 0; // positive = charging
      });

    // Register Flow condition: grid_importing
    this.homey.flow
      .getConditionCard('grid_importing')
      .registerRunListener(async ({ device }) => {
        const gridPower = device.getCapabilityValue('hoymiles_grid_power') ?? 0;
        return gridPower > 0; // positive = importing from grid
      });
  }

}

module.exports = HoymilesHiOneApp;
