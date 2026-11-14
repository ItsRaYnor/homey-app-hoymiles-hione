'use strict';

/**
 * A stand-in for the `homey` module, so the device and driver can be loaded
 * and exercised with plain Node. Only what the tests touch is here: a store,
 * settings, capabilities and availability on the device, and a `homey` object
 * that records the Flow triggers it is asked to fire.
 *
 * Require this file BEFORE requiring anything from drivers/.
 */

const Module = require('module');

class Device {

  constructor() {
    this.fake = { store: {}, settings: {}, capabilities: {}, available: true, errors: [] };
    this.homey = createHomey();
  }

  log() {}

  error(...args) { this.fake.errors.push(args.join(' ')); }

  getSetting(key) { return this.fake.settings[key]; }

  getSettings() { return { ...this.fake.settings }; }

  getStoreValue(key) { return key in this.fake.store ? this.fake.store[key] : null; }

  async setStoreValue(key, value) { this.fake.store[key] = value; }

  hasCapability(capability) { return capability in this.fake.capabilities; }

  getCapabilityValue(capability) {
    const value = this.fake.capabilities[capability];
    return value === undefined ? null : value;
  }

  async setCapabilityValue(capability, value) { this.fake.capabilities[capability] = value; }

  getAvailable() { return this.fake.available; }

  async setAvailable() { this.fake.available = true; }

  async setUnavailable() { this.fake.available = false; }

}

class Driver {

  constructor() {
    this.homey = createHomey();
  }

  log() {}

  error() {}

}

class App {}

/** A `homey` object: translations echo their key, Flow cards remember things. */
function createHomey({ timezone = 'Europe/Amsterdam', language = 'en' } = {}) {
  const cards = new Map();
  const card = (kind, id) => {
    const key = `${kind}:${id}`;
    if (!cards.has(key)) {
      const entry = {
        fired: [],
        listener: null,
        registerRunListener(listener) { entry.listener = listener; return entry; },
        async trigger(device, tokens, state) { entry.fired.push({ tokens, state }); },
      };
      cards.set(key, entry);
    }
    return cards.get(key);
  };
  return {
    __: (key) => key,
    i18n: { getLanguage: () => language },
    clock: { getTimezone: () => timezone },
    settings: { get: () => null, set: () => {} },
    flow: {
      getDeviceTriggerCard: (id) => card('trigger', id),
      getActionCard: (id) => card('action', id),
      getConditionCard: (id) => card('condition', id),
    },
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (...args) => setInterval(...args),
    clearInterval: (id) => clearInterval(id),
  };
}

const stub = { Device, Driver, App };
const load = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === 'homey') return stub;
  return load.call(this, request, ...rest);
};

module.exports = { createHomey, Device, Driver };
