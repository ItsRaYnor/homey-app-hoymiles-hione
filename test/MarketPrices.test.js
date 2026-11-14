'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const MarketPrices = require('../lib/MarketPrices');

test('a Dutch Homey keeps Frank Energie, a German one gets its own market', () => {
  assert.equal(MarketPrices.zoneForTimezone('Europe/Amsterdam'), 'NL');
  assert.equal(MarketPrices.zoneForTimezone('Europe/Berlin'), 'DE-LU');
  assert.equal(MarketPrices.zoneForTimezone('Europe/Vienna'), 'AT');
});

test('a country with several price zones is not guessed', () => {
  assert.equal(MarketPrices.zoneForTimezone('Europe/Stockholm'), null);
  assert.equal(MarketPrices.zoneForTimezone('Europe/Oslo'), null);
  assert.equal(MarketPrices.zoneForTimezone('America/New_York'), null);
});

test('a Homey that will not name its time zone counts as the Netherlands', () => {
  assert.equal(MarketPrices.zoneForTimezone(null), 'NL');
  assert.equal(MarketPrices.zoneForTimezone(undefined), 'NL');
});

test('every time zone points at a zone that is on offer', () => {
  for (const timezone of ['Europe/Amsterdam', 'Europe/Berlin', 'Europe/Luxembourg', 'Europe/Vienna',
    'Europe/Brussels', 'Europe/Paris', 'Europe/Zurich', 'Europe/Warsaw', 'Europe/Prague',
    'Europe/Budapest', 'Europe/Ljubljana']) {
    assert.ok(MarketPrices.ZONES.includes(MarketPrices.zoneForTimezone(timezone)), timezone);
  }
});

test('the request names the zone and one market day', () => {
  assert.equal(
    MarketPrices.urlFor('DE-LU', '2026-11-14'),
    'https://api.energy-charts.info/price?bzn=DE-LU&start=2026-11-14&end=2026-11-14',
  );
});

test('prices come in EUR/MWh and leave in EUR/kWh, quarter by quarter', () => {
  const start = Date.UTC(2026, 10, 13, 23) / 1000;
  const rows = MarketPrices.parse({
    unix_seconds: [start, start + 900, start + 1800],
    price: [200, 100, -50],
    unit: 'EUR / MWh',
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.market), [0.2, 0.1, -0.05]);
  assert.deepEqual(rows.map((row) => row.price), [0.2, 0.1, -0.05]);
  assert.equal(rows[0].from, start * 1000);
  assert.equal(rows[0].till, (start + 900) * 1000);
  // The last slot has no successor to end at: it is as long as the others.
  assert.equal(rows[2].till - rows[2].from, 900 * 1000);
});

test('surcharge and VAT are added to the price, never to what exporting earns', () => {
  const [row] = MarketPrices.parse(
    { unix_seconds: [0, 900], price: [100, 100] },
    { surcharge: 0.18, vat: 0.19 },
  );
  assert.equal(row.market, 0.1);
  assert.ok(Math.abs(row.price - (0.1 + 0.18) * 1.19) < 1e-12);
});

test('quarters that are not published yet are left out', () => {
  const rows = MarketPrices.parse({ unix_seconds: [0, 900, 1800], price: [100, null, 80] });
  assert.deepEqual(rows.map((row) => row.from), [0, 1800 * 1000]);
});

test('an answer without prices is an error, not an empty day', () => {
  assert.throws(() => MarketPrices.parse({}), /no prices/);
  assert.throws(() => MarketPrices.parse({ unix_seconds: [], price: [] }), /no prices/);
  assert.throws(() => MarketPrices.parse({ unix_seconds: [0], price: [null] }), /no prices/);
});
