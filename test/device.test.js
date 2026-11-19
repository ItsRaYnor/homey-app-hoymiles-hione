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

test('outside the Netherlands an exported kWh earns the market price minus the export fee', () => {
  const settings = {
    price_zone: 'DE-LU', price_surcharge: 18, price_vat: 19, price_feed_in_penalty: 5.3, price_export_fee: 1,
  };
  const row = { from: Date.UTC(2026, 0, 15, 12), price: 0.40, market: 0.10 };
  const german = device({ settings });
  german._createPrices(settings);
  assert.ok(Math.abs(german._prices.exportValueOf(row, german._priceOptions()) - 0.09) < 1e-9);

  // In the Netherlands net metering hands the tax back until 2027: only the
  // fees from the invoice count.
  const dutchSettings = { ...settings, price_zone: 'NL' };
  const dutch = device({ settings: dutchSettings });
  dutch._createPrices(dutchSettings);
  assert.ok(Math.abs(dutch._prices.exportValueOf(row, dutch._priceOptions()) - 0.347) < 1e-9);
  const in2027 = { ...row, from: Date.UTC(2027, 0, 15, 12) };
  assert.ok(Math.abs(dutch._prices.exportValueOf(in2027, dutch._priceOptions()) - 0.09) < 1e-9);
});

test('the cheapest-quarter rankings survive a restart', async () => {
  const settings = { price_zone: 'NL' };
  const hione = device({ settings });
  hione._createPrices(settings);
  await hione._prices._rankStore.write({ '8|07:00': { chosen: [1], known: 4 } });
  const restarted = device({ settings });
  restarted.fake.store = hione.fake.store;
  restarted._createPrices(settings);
  assert.deepEqual(await restarted._prices._rankStore.read(), { '8|07:00': { chosen: [1], known: 4 } });
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

// --- the cost of the charge on board ----------------------------------------

/** A plan for the quarter `now` is in, as far as the device reads one. */
const livePlan = (now, extra = {}) => ({
  from: now - 5 * MINUTE, till: now + 10 * MINUTE, priceNow: 0.21, costBasis: 0.30,
  buyNow: false, sellNow: false, peakNow: false, action: 'hold', dayLow: 0.21, dayHigh: 0.44,
  dischargeFloor: 0.3433, lowAhead: 0.15, lowAheadFrom: Date.UTC(2026, 0, 16, 0), ...extra,
});

test('a charge from the grid is booked at the price of its quarter, and kept over a restart', async () => {
  const t0 = Date.UTC(2026, 0, 15, 2);
  const settings = { price_floor_soc: 30, price_capacity_kwh: 10 };
  const hione = device({ settings, capabilities: { measure_battery: 30.5 } });
  hione._pricePlan = livePlan(t0);
  const data = { batteryPower: 5000, gridPower: 5500, source: 'modbus' };
  hione._trackChargeCost(data, t0);
  hione._trackChargeCost(data, t0 + MINUTE);
  // Charged from (nearly) the floor: the purchase is the whole average.
  assert.ok(Math.abs(hione._priceOptions().chargeCost - 0.21) < 1e-9);
  assert.ok(Math.abs(hione.getStoreValue('charge_cost').avg - 0.21) < 1e-9);

  const restarted = device({ settings, capabilities: { measure_battery: 31 } });
  restarted.fake.store = hione.fake.store;
  assert.ok(Math.abs(restarted._priceOptions().chargeCost - 0.21) < 1e-9);
});

test('while the other battery discharges, a charge counts as bought from the grid', () => {
  const t0 = Date.UTC(2026, 0, 15, 12);
  const settings = { price_floor_soc: 30, price_capacity_kwh: 10 };
  // The meter shows export: the other battery's 5 kW hides our 5 kW import.
  const data = { batteryPower: 5000, gridPower: -200, source: 'modbus' };
  const book = (otherDischarging) => {
    const hione = device({ settings, capabilities: { measure_battery: 30.5 } });
    hione._otherBatteryReports = { charging: 0, discharging: otherDischarging ? Date.now() : 0 };
    hione._pricePlan = livePlan(t0, { priceNow: 0.30, marketNow: 0.10 });
    hione._prices = { exportValueOf: () => 0.25 };
    hione._trackChargeCost(data, t0);
    hione._trackChargeCost(data, t0 + MINUTE);
    return hione._priceOptions().chargeCost;
  };
  assert.ok(Math.abs(book(false) - 0.25) < 1e-9, 'looks like sun');
  assert.ok(Math.abs(book(true) - 0.30) < 1e-9, 'is the grid');
});

test('a stale cloud snapshot is not booked as a charge', () => {
  const t0 = Date.UTC(2026, 0, 15, 2);
  const hione = device({ settings: { price_floor_soc: 30 }, capabilities: { measure_battery: 31 } });
  hione._isCloudOnly = () => false;
  hione._pricePlan = livePlan(t0);
  hione._trackChargeCost({ batteryPower: 5000, gridPower: 5500, source: 'modbus' }, t0);
  hione._trackChargeCost({ batteryPower: 5000, gridPower: 5500, source: 'cloud' }, t0 + MINUTE);
  assert.equal(hione._priceOptions().chargeCost, undefined);
});

// --- quarters ---------------------------------------------------------------

test('a new quarter refreshes the tiles and starts the cheapest-quarter Flows once', async () => {
  const now = Date.UTC(2026, 0, 15, 14, 0, 3);
  const hione = device({ capabilities: {
    hoymiles_price_low_ahead: null, hoymiles_price_low_ahead_time: null, hoymiles_price_charge_cost: null,
  } });
  hione._lastPriceRefresh = 0;
  hione._prices = {};
  hione.getPricePlan = async () => livePlan(now);
  await hione._onQuarter(now);
  await hione._onQuarter(now + MINUTE);

  assert.deepEqual(fired(hione, 'price_cheapest_quarters_start'), [
    { tokens: { price: 21 }, state: { from: Date.UTC(2026, 0, 15, 14) } },
  ]);
  assert.equal(hione.getCapabilityValue('hoymiles_price_low_ahead'), 15);
  assert.equal(hione.getCapabilityValue('hoymiles_price_low_ahead_time'), '01:00');
  assert.equal(hione.getCapabilityValue('hoymiles_price_charge_cost'), 30);
});

test('nothing to charge is never a cheap quarter, and no power is an error', async () => {
  const hione = device();
  hione._prices = { cheapestQuarters: async () => ({ chosen: new Set(), known: 4 }) };
  assert.equal(await hione.priceIsNeededForEnergy(0, 6.9, '07:00'), false);
  await assert.rejects(hione.priceIsNeededForEnergy(5, 0, '07:00'), /invalid_power/);
});

test('a quarter is cheap when the ranking chose it', async () => {
  const now = Date.UTC(2026, 0, 15, 14, 7);
  const asked = [];
  const hione = device();
  hione._prices = {
    cheapestQuarters: async (count, until, at) => {
      asked.push({ count, until, at });
      return { chosen: new Set([Date.UTC(2026, 0, 15, 14)]), known: 40 };
    },
  };
  assert.equal(await hione.priceIsCheapestQuarter(12, '07:00', now), true);
  // 5 kWh at 6.9 kW is three quarters.
  await hione.priceIsNeededForEnergy(5, 6.9, '07:00', now);
  assert.deepEqual(asked.map((a) => a.count), [12, 3]);
  assert.equal(asked[0].until, Date.UTC(2026, 0, 16, 6));

  hione._prices = { cheapestQuarters: async () => ({ chosen: new Set(), known: 0 }) };
  await assert.rejects(hione.priceIsCheapestQuarter(12, '07:00', now), /no_prices/);
});

// --- Insights after a restart ------------------------------------------------

test('the first plan after a start empties the slow tiles once, so Insights logs it', async () => {
  const now = Date.UTC(2026, 0, 15, 14, 7);
  // The device already holds the right floor; Insights may hold a stale one.
  const hione = device({ capabilities: {
    hoymiles_price_discharge_floor: 34.3, hoymiles_price_low_today: 21, hoymiles_price_now: 21,
  } });
  hione._prices = {};
  hione.getPricePlan = async () => livePlan(now);
  const writes = [];
  const write = hione.setCapabilityValue.bind(hione);
  hione.setCapabilityValue = async (capability, value) => {
    writes.push([capability, value]);
    return write(capability, value);
  };

  await hione._doRefreshPricePlan();
  await hione._doRefreshPricePlan();

  const floor = writes.filter(([capability]) => capability === 'hoymiles_price_discharge_floor');
  assert.deepEqual(floor.map(([, value]) => value), [null, 34.3, 34.3]);
  assert.deepEqual(writes.filter(([c]) => c === 'hoymiles_price_low_today').map(([, v]) => v), [null, 21, 21]);
  // The price itself moves every quarter: no gap needed there.
  assert.ok(!writes.some(([c, v]) => c === 'hoymiles_price_now' && v === null));
  assert.equal(hione.getCapabilityValue('hoymiles_price_discharge_floor'), 34.3);
});
