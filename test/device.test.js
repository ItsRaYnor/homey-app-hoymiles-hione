'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHomey } = require('./helpers/homey');
const HiOneDevice = require('../drivers/hione/device');

const MINUTE = 60 * 1000;

/** A device that has not been through onInit: only the fields a test sets. */
function device({ settings = {}, capabilities = {}, homey } = {}) {
  const instance = new HiOneDevice();
  if (homey) instance.homey = homey;
  Object.assign(instance.fake.settings, settings);
  Object.assign(instance.fake.capabilities, capabilities);
  return instance;
}

const fired = (instance, card) => instance.homey.flow.getDeviceTriggerCard(card).fired;
const plan = (flags) => ({ priceNow: 0.314, buyNow: false, sellNow: false, peakNow: false, ...flags });

// --- price moment triggers ---------------------------------------------------

test('the first plan of a new device announces nothing', async () => {
  const hione = device();
  await hione._firePriceMomentTriggers(plan({ sellNow: true }));
  assert.equal(fired(hione, 'price_moment_started').length, 0);
  assert.equal(fired(hione, 'price_moment_ended').length, 0);
  assert.deepEqual(hione.getStoreValue('price_moments'), { buy: false, sell: true, peak: false });
});

test('a moment that begins starts a Flow once, with the price as a tag', async () => {
  const hione = device();
  await hione._firePriceMomentTriggers(plan());
  await hione._firePriceMomentTriggers(plan({ sellNow: true }));
  await hione._firePriceMomentTriggers(plan({ sellNow: true }));
  await hione._firePriceMomentTriggers(plan({ sellNow: true }));

  assert.deepEqual(fired(hione, 'price_moment_started'), [
    { tokens: { price: 31.4 }, state: { moment: 'sell' } },
  ]);
  assert.equal(fired(hione, 'price_moment_ended').length, 0);
});

test('a moment that is over ends once', async () => {
  const hione = device();
  await hione._firePriceMomentTriggers(plan({ buyNow: true }));
  await hione._firePriceMomentTriggers(plan());
  await hione._firePriceMomentTriggers(plan());
  assert.deepEqual(fired(hione, 'price_moment_ended'), [
    { tokens: { price: 31.4 }, state: { moment: 'buy' } },
  ]);
});

test('two moments can change in the same minute', async () => {
  const hione = device();
  await hione._firePriceMomentTriggers(plan({ peakNow: true }));
  await hione._firePriceMomentTriggers(plan({ sellNow: true }));
  assert.deepEqual(fired(hione, 'price_moment_started').map((f) => f.state.moment), ['sell']);
  assert.deepEqual(fired(hione, 'price_moment_ended').map((f) => f.state.moment), ['peak']);
});

test('an app restart in the middle of a moment does not announce it again', async () => {
  const before = device();
  await before._firePriceMomentTriggers(plan());
  await before._firePriceMomentTriggers(plan({ sellNow: true }));

  const after = device();
  after.fake.store = before.fake.store; // the device store survives the restart
  await after._firePriceMomentTriggers(plan({ sellNow: true }));
  assert.equal(fired(after, 'price_moment_started').length, 0);
});

test('a moment that began while the app was down is announced afterwards', async () => {
  const before = device();
  await before._firePriceMomentTriggers(plan());

  const after = device();
  after.fake.store = before.fake.store;
  await after._firePriceMomentTriggers(plan({ buyNow: true }));
  assert.deepEqual(fired(after, 'price_moment_started').map((f) => f.state.moment), ['buy']);
});

// --- poll tolerance ----------------------------------------------------------

/** A device whose poll does nothing but succeed or fail on demand. */
function pollable() {
  const hione = device();
  hione._pollFailures = 0;
  hione._pollEverSucceeded = false;
  hione._lastSettingsRefresh = Date.now();
  hione.fail = false;
  hione._hybrid = {
    getData: async () => {
      if (hione.fail) throw new Error('ETIMEDOUT');
      return { batteryPower: 0, batterySoc: 50, source: 'modbus', batteryMode: null };
    },
  };
  for (const step of ['_refreshLocalSettings', '_refreshBmsData', '_refreshPricePlan', '_applyCloudMarkers']) {
    hione[step] = async () => {};
  }
  return hione;
}

test('one failed poll after a good one leaves the device available', async () => {
  const hione = pollable();
  await hione._poll();
  hione.fail = true;
  await hione._poll();
  await hione._poll();
  assert.equal(hione.getAvailable(), true);
});

test('three failed polls in a row mark the device unavailable', async () => {
  const hione = pollable();
  await hione._poll();
  hione.fail = true;
  await hione._poll();
  await hione._poll();
  await hione._poll();
  assert.equal(hione.getAvailable(), false);
});

test('a good poll in between starts the count again', async () => {
  const hione = pollable();
  await hione._poll();
  for (let round = 0; round < 3; round++) {
    hione.fail = true;
    await hione._poll();
    await hione._poll();
    hione.fail = false;
    await hione._poll();
  }
  assert.equal(hione.getAvailable(), true);
});

test('the device comes back as soon as a poll succeeds', async () => {
  const hione = pollable();
  await hione._poll();
  hione.fail = true;
  await hione._poll();
  await hione._poll();
  await hione._poll();
  hione.fail = false;
  await hione._poll();
  assert.equal(hione.getAvailable(), true);
});

test('a device that has never polled shows the failure at once', async () => {
  const hione = pollable();
  hione.fail = true;
  await hione._poll();
  assert.equal(hione.getAvailable(), false);
});

// --- price zone --------------------------------------------------------------

test('on automatic the zone follows the time zone of Homey', () => {
  const zone = (timezone) => device({ homey: createHomey({ timezone }) })._resolvePriceZone({ price_zone: 'auto' });
  assert.equal(zone('Europe/Amsterdam'), 'NL');
  assert.equal(zone('Europe/Berlin'), 'DE-LU');
  assert.equal(zone('Europe/Stockholm'), null);
});

test('a chosen zone wins over the time zone', () => {
  const hione = device({ homey: createHomey({ timezone: 'Europe/Amsterdam' }) });
  assert.equal(hione._resolvePriceZone({ price_zone: 'SE4' }), 'SE4');
  // A device paired before the setting existed has no value for it at all.
  assert.equal(hione._resolvePriceZone({}), 'NL');
});

test('without a zone there is no plan, and no error either', async () => {
  const hione = device({ homey: createHomey({ timezone: 'Europe/Stockholm' }) });
  hione._createPrices({ price_zone: 'auto' });
  assert.equal(hione._priceZone, null);
  assert.equal(await hione.getPricePlan(), null);
  assert.equal(await hione.getPriceCurve(), null);
});

test('outside the Netherlands an exported kWh also loses the surcharge', () => {
  const settings = { price_zone: 'DE-LU', price_surcharge: 18, price_vat: 19, price_feed_in_penalty: 0 };
  const german = device({ settings });
  german._createPrices(settings);
  assert.ok(Math.abs(german._priceOptions().feedInPenalty - 0.18 * 1.19) < 1e-9);

  // In the Netherlands net metering hands it back: only the fee from the invoice counts.
  const dutchSettings = { ...settings, price_zone: 'NL', price_feed_in_penalty: 5.3 };
  const dutch = device({ settings: dutchSettings });
  dutch._createPrices(dutchSettings);
  assert.ok(Math.abs(dutch._priceOptions().feedInPenalty - 0.053) < 1e-9);
});

// --- trusted state of charge -------------------------------------------------

test('a reading that fits the energy that flowed is believed', () => {
  const hione = device({ settings: { price_capacity_kwh: 10 } });
  const t0 = Date.UTC(2026, 9, 10, 10);
  assert.equal(hione._trustedSoc({ batterySoc: 80, batteryPower: 0, source: 'modbus' }, t0), 80);
  assert.equal(hione._trustedSoc({ batterySoc: 81, batteryPower: 0, source: 'modbus' }, t0 + MINUTE), 81);
});

test('a reading the battery cannot have reached is replaced by an estimate', () => {
  const hione = device({ settings: { price_capacity_kwh: 10 } });
  const t0 = Date.UTC(2026, 9, 10, 10);
  hione._trustedSoc({ batterySoc: 85, batteryPower: 0, source: 'modbus' }, t0);
  // An idle pack does not drop 41 points in a minute (seen live on 2026-10-10).
  assert.equal(hione._trustedSoc({ batterySoc: 44, batteryPower: 0, source: 'modbus' }, t0 + MINUTE), 85);
});

test('right after a start a cloud reading is not taken as the reference', () => {
  const hione = device({ settings: { price_capacity_kwh: 10 } });
  assert.equal(hione._trustedSoc({ batterySoc: 44, batteryPower: 0, source: 'cloud' }, Date.now()), null);
});
