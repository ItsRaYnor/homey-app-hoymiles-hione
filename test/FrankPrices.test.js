'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const FrankPrices = require('../lib/FrankPrices');

const HOUR = 3600 * 1000;
const QUARTER = HOUR / 4;
// 2026-01-15 00:00 in Amsterdam: winter time, one hour ahead of UTC.
const DAY = Date.UTC(2026, 0, 14, 23);
const TODAY = '2026-01-15';
const TOMORROW = '2026-01-16';

/** 24 hourly rows from `start`; exporting earns 15 ct less than importing costs. */
const hourly = (start, list) => list.map((price, hour) => ({
  from: start + hour * HOUR,
  till: start + (hour + 1) * HOUR,
  price,
  market: price - 0.15,
}));

/** The same day in quarter hours, as the market has published it since 2025. */
const quarterly = (start, list) => hourly(start, list).flatMap((row) => [0, 1, 2, 3].map((q) => ({
  ...row,
  from: row.from + q * QUARTER,
  till: row.from + (q + 1) * QUARTER,
})));

/** A moment on the test day, Amsterdam clock. */
const at = (hour, minute = 0) => DAY + hour * HOUR + minute * 60 * 1000;

// A cheap midday, a dear evening and nothing in between worth trading on.
const SHAPED = [
  0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15,
  0.10, 0.10, 0.10,
  0.15, 0.15, 0.15, 0.15,
  0.40, 0.40, 0.40, 0.40,
  0.15, 0.15,
];
const FLAT = new Array(24).fill(0.25);

/** A price source that serves `days` instead of the network, and counts the asks. */
function source(days, options = {}) {
  const prices = new FrankPrices({ fallbackEndpoint: null, ...options });
  prices.asked = [];
  prices._fetch = async (date) => {
    prices.asked.push(date);
    if (!days[date]) throw new Error('no prices returned');
    return days[date];
  };
  return prices;
}

const shaped = (options) => source({ [TODAY]: hourly(DAY, SHAPED) }, options);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test('the day low and high and the discharge floor follow from the prices', async () => {
  const plan = await shaped().getPlan({}, at(3));
  assert.equal(plan.dayLow, 0.10);
  assert.equal(plan.dayHigh, 0.40);
  // low / efficiency + wear + margin
  near(plan.dischargeFloor, 0.10 / 0.9 + 0.06 + 0.05);
  assert.equal(plan.spreadPays, true);
  assert.equal(plan.slotMinutes, 60);
  assert.equal(plan.source, 'frank');
});

test('the cheap midday before a dear evening is a buy moment', async () => {
  const plan = await shaped().getPlan({}, at(12, 30));
  assert.equal(plan.buyNow, true);
  assert.equal(plan.dischargeNow, false);
  assert.equal(plan.action, 'buy');
});

test('a night that is cheap but not the cheapest waits for the midday', async () => {
  const plan = await shaped().getPlan({}, at(3));
  assert.equal(plan.buyNow, false);
  assert.equal(plan.action, 'hold');
  assert.equal(plan.nextBuyPrice, 0.10);
  assert.equal(plan.nextBuyFrom, at(11));
});

test('the dear evening is a peak to discharge into, never a buy moment', async () => {
  const plan = await shaped().getPlan({ usableKwh: 10, loadKw: 1 }, at(19, 30));
  assert.equal(plan.dischargeNow, true);
  assert.equal(plan.peakNow, true);
  assert.equal(plan.buyNow, false);
});

test('a flat day trades nothing', async () => {
  const plan = await source({ [TODAY]: hourly(DAY, FLAT) }).getPlan({}, at(12));
  assert.equal(plan.spreadPays, false);
  assert.equal(plan.buyNow, false);
  assert.equal(plan.sellNow, false);
  assert.equal(plan.action, 'flat');
});

test('the charge target is the floor plus what the dear hours will draw', async () => {
  // Four dear hours at 1 kW out of a 10 kWh pack is 40% on top of the 30% floor.
  const plan = await shaped().getPlan(
    { loadKw: 1, capacityKwh: 10, floorSoc: 30, sellKw: 0 }, at(12, 30),
  );
  near(plan.energyNeededKwh, 4);
  assert.equal(plan.chargeTarget, 70);
});

test('the charge target counts selling, and never aims at the very top', async () => {
  const plan = await shaped().getPlan(
    { loadKw: 1, capacityKwh: 10, floorSoc: 30, sellKw: 5 }, at(12, 30),
  );
  near(plan.energyNeededKwh, 20);
  assert.equal(plan.chargeTarget, 95);
});

test('without a house load there is no charge target, rather than a guess', async () => {
  const plan = await shaped().getPlan({}, at(12, 30));
  assert.equal(plan.chargeTarget, null);
});

test('a cheap tomorrow lowers the floor for tonight', async () => {
  const prices = source({
    [TODAY]: hourly(DAY, SHAPED),
    [TOMORROW]: hourly(DAY + 24 * HOUR, new Array(24).fill(0.05)),
  });
  const plan = await prices.getPlan({}, at(19));
  assert.equal(plan.tomorrowLow, 0.05);
  assert.equal(plan.referenceLow, 0.05);
  near(plan.dischargeFloor, 0.05 / 0.9 + 0.06 + 0.05);
});

test('no price for this hour means no plan, not the last price standing', async () => {
  const morningOnly = hourly(DAY, SHAPED).slice(0, 6);
  assert.equal(await source({ [TODAY]: morningOnly }).getPlan({}, at(12)), null);
});

test('a price outage yields no plan and never throws', async () => {
  assert.equal(await source({}).getPlan({}, at(12)), null);
});

test('a fetched day is not asked for again', async () => {
  const prices = shaped();
  await prices.getPlan({}, at(9));
  await prices.getPlan({}, at(10));
  assert.equal(prices.asked.filter((date) => date === TODAY).length, 1);
});

test('the curve gives every hour its verdict and marks the one running now', async () => {
  const curve = await shaped().getCurve({}, at(12, 30));
  assert.equal(curve.hours.length, 24);
  assert.equal(curve.date, TODAY);
  assert.deepEqual(curve.hours.map((hour, i) => (hour.now ? i : null)).filter((i) => i !== null), [12]);
  assert.deepEqual(curve.hours.slice(11, 14).map((hour) => hour.buy), [true, true, true]);
  assert.deepEqual(curve.hours.slice(18, 22).map((hour) => hour.discharge), [true, true, true, true]);
  assert.equal(curve.hours[3].buy, false);
});

test('a single quarter just outside a buy run is bridged, not obeyed', () => {
  const list = [0.10, 0.125, 0.10, 0.40];
  const timeline = list.map((price, i) => ({
    from: DAY + i * QUARTER, till: DAY + (i + 1) * QUARTER, price, market: price,
  }));
  const settings = { ...FrankPrices.DEFAULTS };
  const flags = FrankPrices._slotFlags(timeline, settings, { dischargeFloor: 0.2211 });
  assert.deepEqual(flags.buyRaw, [true, false, true, false]);
  assert.deepEqual(flags.buy, [true, true, true, false]);
});

test('a bridged quarter never becomes a trade that loses money', () => {
  // The middle quarter is dear enough to discharge into: no bridge across it.
  const list = [0.10, 0.30, 0.10, 0.40];
  const timeline = list.map((price, i) => ({
    from: DAY + i * QUARTER, till: DAY + (i + 1) * QUARTER, price, market: price,
  }));
  const flags = FrankPrices._slotFlags(timeline, { ...FrankPrices.DEFAULTS }, { dischargeFloor: 0.2211 });
  assert.equal(flags.buy[1], false);
});

test('a market day is the Amsterdam day, whatever clock the process runs on', () => {
  // 22:30 UTC in summer is already half past midnight in Amsterdam.
  assert.equal(FrankPrices.localDate(new Date('2026-07-01T22:30:00Z')), '2026-07-02');
  assert.equal(FrankPrices.localHour(Date.parse('2026-07-01T22:30:00Z')), 0);
  assert.equal(FrankPrices.localDate(new Date('2026-01-14T22:30:00Z')), '2026-01-14');
});

test('the next day is the next day across both clock changes', () => {
  const next = (iso) => FrankPrices.localDate(new Date(FrankPrices.nextDayStart(Date.parse(iso))));
  assert.equal(next('2026-03-28T12:00:00Z'), '2026-03-29');
  assert.equal(next('2026-03-29T12:00:00Z'), '2026-03-30');
  assert.equal(next('2026-10-24T12:00:00Z'), '2026-10-25');
  assert.equal(next('2026-10-25T00:30:00Z'), '2026-10-26');
});

test('a slot is weighed by its length', () => {
  assert.equal(FrankPrices.slotHours({ from: 0, till: QUARTER }), 0.25);
  assert.equal(FrankPrices.slotHours({ from: 0, till: HOUR }), 1);
});

// --- storage -----------------------------------------------------------------

function memoryStore() {
  let saved = null;
  return {
    read: () => saved,
    write: (value) => { saved = JSON.parse(JSON.stringify(value)); },
    peek: () => saved,
  };
}

test('a restart carries on with the day it already had', async () => {
  const store = memoryStore();
  await source({ [TODAY]: quarterly(DAY, SHAPED) }, { store }).getPlan({}, at(9));

  const afterRestart = source({}, { store });
  const plan = await afterRestart.getPlan({}, at(12, 30));
  assert.equal(plan.action, 'buy');
  assert.ok(!afterRestart.asked.includes(TODAY));
});

test('a day stored in whole hours is fetched again, and stands in meanwhile', async () => {
  const store = memoryStore();
  await shaped({ store }).getPlan({}, at(9));

  const afterRestart = source({}, { store });
  const plan = await afterRestart.getPlan({}, at(12, 30));
  assert.equal(plan.action, 'buy');
  assert.ok(afterRestart.asked.includes(TODAY));
});

test('a day stored for another zone or surcharge is not reused', async () => {
  const store = memoryStore();
  await shaped({ store, zone: 'DE-LU', surcharge: 0.18, vat: 0.19 }).getPlan({}, at(14));
  assert.equal(store.peek().zone, 'DE-LU|0.18|0.19');

  const sameAgain = source({}, { store, zone: 'DE-LU', surcharge: 0.18, vat: 0.19 });
  assert.ok(await sameAgain.getPlan({}, at(14)));

  const otherZone = source({}, { store, zone: 'AT', surcharge: 0.18, vat: 0.19 });
  assert.equal(await otherZone.getPlan({}, at(14)), null);

  const otherSurcharge = source({}, { store, zone: 'DE-LU', surcharge: 0.2, vat: 0.19 });
  assert.equal(await otherSurcharge.getPlan({}, at(14)), null);

  // And a Dutch source does not take a German day for its own.
  assert.equal(await source({}, { store }).getPlan({}, at(14)), null);
});

// --- zones outside the Netherlands -------------------------------------------

test('outside the Netherlands tomorrow is not asked for before it can be out', async () => {
  const morning = shaped({ zone: 'DE-LU' });
  await morning.getPlan({}, at(10));
  assert.deepEqual(morning.asked, [TODAY]);

  const afternoon = shaped({ zone: 'DE-LU' });
  await afternoon.getPlan({}, at(14));
  assert.deepEqual(afternoon.asked, [TODAY, TOMORROW]);
});

test('a market day is labelled as such, so the page can name its source', async () => {
  const plan = await shaped({ zone: 'DE-LU' }).getPlan({}, at(12));
  assert.equal(plan.source, 'market');
});

test('a failed market day is retried at the slower pace', async () => {
  const prices = source({}, { zone: 'DE-LU' });
  await prices.getPlan({}, at(9));
  await prices.getPlan({}, at(9, 6));   // six minutes later: too soon
  assert.equal(prices.asked.length, 1);
  await prices.getPlan({}, at(9, 16));  // a quarter of an hour later: again
  assert.equal(prices.asked.length, 2);
});
