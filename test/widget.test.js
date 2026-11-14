'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getPrices } = require('../widgets/price_plan/api');

const slot = (flags) => ({ from: 0, till: 900000, price: 0.3, market: 0.1, now: false, ...flags });

/** A `homey` with the given devices behind the hione driver. */
const homeyWith = (devices, language = 'nl') => ({
  i18n: { getLanguage: () => language },
  drivers: { getDriver: () => ({ getDevices: () => devices }) },
});

const device = (overrides = {}) => ({
  _isCloudOnly: () => false,
  getSetting: () => true,
  getPriceZone: () => 'NL',
  getPriceCurve: async () => ({
    zone: 'NL',
    planText: 'Kopen ≤ 14,0',
    dayLow: 0.14,
    dayHigh: 0.47,
    dischargeFloor: 0.27,
    hours: [
      slot({ buy: true }),
      slot({ sell: true, peak: true, discharge: true }),
      slot({ peak: true, discharge: true }),
      slot({ discharge: true }),
      slot({ now: true }),
    ],
  }),
  ...overrides,
});

test('the widget says why there is nothing to draw, in a state it can translate', async () => {
  const ask = (devices, query) => getPrices({ homey: homeyWith(devices), query });
  assert.equal((await ask([])).state, 'no_device');
  assert.equal((await ask([device({ getSetting: () => false })])).state, 'disabled');
  assert.equal((await ask([device({ getPriceZone: () => null })])).state, 'no_zone');
  assert.equal((await ask([device({ getPriceCurve: async () => null })])).state, 'no_prices');
  assert.equal((await ask([device({ getPriceCurve: async () => null })], { day: 'tomorrow' })).state, 'not_yet');
});

test('a driver that is not ready yet is not an error', async () => {
  const homey = { i18n: { getLanguage: () => 'en' }, drivers: { getDriver: () => { throw new Error('not ready'); } } };
  assert.equal((await getPrices({ homey, query: {} })).state, 'no_device');
});

test('each slot carries one verdict, the same order of precedence as the chart', async () => {
  const answer = await getPrices({ homey: homeyWith([device()]), query: { day: 'today' } });
  assert.equal(answer.state, 'ok');
  assert.equal(answer.language, 'nl');
  assert.equal(answer.planText, 'Kopen ≤ 14,0');
  assert.deepEqual(answer.slots.map((s) => s.verdict), ['buy', 'sell', 'peak', 'later', 'hold']);
  assert.deepEqual(answer.slots.map((s) => s.now), [false, false, false, false, true]);
});

test('the device with a stick is preferred over a cloud-only one', async () => {
  const asked = [];
  const cloud = device({ _isCloudOnly: () => true, getPriceCurve: async () => { asked.push('cloud'); return null; } });
  const local = device({ getPriceCurve: async () => { asked.push('local'); return null; } });
  await getPrices({ homey: homeyWith([cloud, local]), query: {} });
  assert.deepEqual(asked, ['local']);
});

test('anything but tomorrow is today', async () => {
  const days = [];
  const spy = device({ getPriceCurve: async (day) => { days.push(day); return null; } });
  await getPrices({ homey: homeyWith([spy]), query: { day: 'yesterday' } });
  await getPrices({ homey: homeyWith([spy]), query: undefined });
  await getPrices({ homey: homeyWith([spy]), query: { day: 'tomorrow' } });
  assert.deepEqual(days, ['today', 'today', 'tomorrow']);
});
