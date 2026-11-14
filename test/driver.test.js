'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/homey');
const HiOneDriver = require('../drivers/hione/driver');

/** The driver with its Flow listeners registered, and a way to run one. */
async function driver() {
  const instance = new HiOneDriver();
  await instance.onInit();
  const run = (kind, id, args, state) => {
    const getter = { condition: 'getConditionCard', action: 'getActionCard', trigger: 'getDeviceTriggerCard' }[kind];
    const { listener } = instance.homey.flow[getter](id);
    assert.equal(typeof listener, 'function', `${kind} ${id} has no listener`);
    return listener(args, state);
  };
  return { instance, run };
}

/** A device as far as the Flow cards look at it. */
const battery = (values, extra = {}) => ({
  getCapabilityValue: (capability) => (capability in values ? values[capability] : null),
  ...extra,
});

test('a battery at rest reading 1 W is not charging', async () => {
  const { run } = await driver();
  const charging = (watts) => run('condition', 'battery_charging', { device: battery({ measure_power: watts }) });
  assert.equal(await charging(1), false);
  assert.equal(await charging(50), false);
  assert.equal(await charging(51), true);
  assert.equal(await charging(-2000), false);
  assert.equal(await charging(null), false);
});

test('idle and discharging use a threshold, 50 W unless the card says otherwise', async () => {
  const { run } = await driver();
  const device = battery({ measure_power: -80 });
  assert.equal(await run('condition', 'battery_idle', { device }), false);
  assert.equal(await run('condition', 'battery_idle', { device, threshold: 100 }), true);
  assert.equal(await run('condition', 'battery_discharging', { device }), true);
  assert.equal(await run('condition', 'battery_discharging', { device, threshold: 100 }), false);
});

test('a price condition without prices stops the Flow instead of answering no', async () => {
  const { run } = await driver();
  const device = battery({}, { getPricePlan: async () => null });
  for (const card of ['price_is_buy_moment', 'price_is_sell_moment', 'price_is_peak_hour',
    'price_discharge_pays', 'price_spread_pays', 'price_cheaper_refill_ahead', 'price_charge_needed']) {
    await assert.rejects(run('condition', card, { device }), /no_prices/, card);
  }
});

test('the price conditions answer from the plan', async () => {
  const { run } = await driver();
  const device = battery({}, { getPricePlan: async () => ({ buyNow: true, sellNow: false, peakNow: 1 }) });
  assert.equal(await run('condition', 'price_is_buy_moment', { device }), true);
  assert.equal(await run('condition', 'price_is_sell_moment', { device }), false);
  assert.equal(await run('condition', 'price_is_peak_hour', { device }), true);
});

test('charging is only needed below the target, with a margin', async () => {
  const { run } = await driver();
  const needed = (soc) => run('condition', 'price_charge_needed', {
    device: battery({ measure_battery: soc }, { getPricePlan: async () => ({ chargeTarget: 70 }) }),
  });
  assert.equal(await needed(50), true);
  assert.equal(await needed(67), true);
  assert.equal(await needed(68), false);
  assert.equal(await needed(90), false);
});

test('a price moment trigger only starts the Flows that listen to that moment', async () => {
  const { run } = await driver();
  for (const card of ['price_moment_started', 'price_moment_ended']) {
    assert.equal(await run('trigger', card, { moment: 'sell' }, { moment: 'sell' }), true);
    assert.equal(await run('trigger', card, { moment: 'buy' }, { moment: 'sell' }), false);
  }
});

test('any transport over the LAN counts as a local connection', async () => {
  const { run } = await driver();
  const local = (source) => run('condition', 'connection_is_local', {
    device: battery({ hoymiles_connection_source: source }),
  });
  assert.equal(await local('modbus'), true);
  assert.equal(await local('modbus_cloud'), true);
  assert.equal(await local('native'), true);
  assert.equal(await local('cloud'), false);
});

test('every Flow card in the manifest has a listener, except the plain triggers', async () => {
  const { instance } = await driver();
  const { flow } = require('../app.json');
  for (const card of flow.actions) {
    assert.equal(typeof instance.homey.flow.getActionCard(card.id).listener, 'function', card.id);
  }
  for (const card of flow.conditions) {
    assert.equal(typeof instance.homey.flow.getConditionCard(card.id).listener, 'function', card.id);
  }
  // A trigger needs a listener only when it has arguments beyond the device.
  for (const card of flow.triggers) {
    const filtered = card.args.some((arg) => arg.type !== 'device');
    const { listener } = instance.homey.flow.getDeviceTriggerCard(card.id);
    assert.equal(typeof listener === 'function', filtered, card.id);
  }
});
