'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const FrankPrices = require('../lib/FrankPrices');
const ChargeCost = require('../lib/ChargeCost');

const HOUR = 3600 * 1000;
const QUARTER = HOUR / 4;
const MINUTE = 60 * 1000;
// 2026-01-15 00:00 in Amsterdam: winter time, one hour ahead of UTC.
const DAY = Date.UTC(2026, 0, 14, 23);
const NEXT = DAY + 24 * HOUR;
const TODAY = '2026-01-15';
const TOMORROW = '2026-01-16';

/** Quarter rows from `start`, one price per quarter; export earns 15 ct less. */
const quarters = (start, list) => list.map((price, i) => ({
  from: start + i * QUARTER,
  till: start + (i + 1) * QUARTER,
  price,
  market: price - 0.15,
}));

/** 96 quarter prices: `base` everywhere, then `set(hour, minute)` overrides. */
function day(base, overrides) {
  return Array.from({ length: 96 }, (_, i) => {
    const hour = Math.floor(i / 4);
    const minute = (i % 4) * 15;
    const value = overrides(hour, minute);
    return value === undefined ? base : value;
  });
}

/** A price source that serves `days` instead of the network. */
function source(days, options = {}) {
  const prices = new FrankPrices({ fallbackEndpoint: null, ...options });
  prices._fetch = async (date) => {
    if (!days[date]) throw new Error('no prices returned');
    return days[date];
  };
  return prices;
}

const at = (hour, minute = 0) => DAY + hour * HOUR + minute * MINUTE;
const near = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) < eps, `${actual} is not ${expected}`);
const slotAt = (curve, hour, minute = 0) => curve.hours.find((h) => h.from === NEXT + hour * HOUR + minute * MINUTE);
const colour = (slot) => (slot.buy && 'buy') || (slot.sell && 'sell') || (slot.peak && 'peak')
  || (slot.discharge && 'later') || 'hold';

// --- the scenario of 2026-11-18 -----------------------------------------------
//
// Tomorrow runs 33.1-44.4 ct with a morning spike at 08:15 and an evening of
// 40-43 ct. Its own low puts the floor for new charge at 47.7 ct, above every
// price of the day: before 1.1.12 the whole day was grey. The battery starts
// it at 87%, bought tonight at 21 ct.

const TOMORROW_PRICES = day(0.35, (hour, minute) => {
  if (hour < 6) return 0.331 + (hour % 3) * 0.003;
  if (hour === 7) return 0.38;
  if (hour === 8) return [0.42, 0.444, 0.42, 0.40][minute / 15];
  if (hour >= 12 && hour < 16) return 0.335;
  if (hour >= 17 && hour < 20) return [0.40, 0.41, 0.42, 0.43][minute / 15];
  return undefined;
});
const TODAY_PRICES = day(0.29, (hour) => {
  if (hour >= 2 && hour < 5) return 0.21;
  if (hour >= 8 && hour < 20) return 0.30;
  return undefined;
});
const scenario = () => source({
  [TODAY]: quarters(DAY, TODAY_PRICES),
  [TOMORROW]: quarters(NEXT, TOMORROW_PRICES),
});
const BATTERY = {
  usableKwh: (87 - 30) / 100 * 31.2, // 87% with a 30% floor on a 31.2 kWh pack
  loadKw: 0.5,
  capacityKwh: 31.2,
  floorSoc: 30,
  sellKw: 5,
  chargeCost: 0.21,
};

test('a charge bought at 21 ct makes tomorrow\'s peaks worth discharging into', async () => {
  const curve = await scenario().getCurve(BATTERY, at(20), 'tomorrow');

  // The floor for new charge is still the one of before...
  near(curve.newFloor, 0.331 / 0.9 + 0.06 + 0.05);
  near(curve.dischargeFloor, curve.newFloor);
  // ...but the charge on board only has to beat what it cost. Tonight's
  // 29 ct buy moment tops it up towards the charge target, so that cost is a
  // blend of the 21 ct on board and the 29 ct bought tonight.
  assert.ok(curve.costBasis > 0.21 && curve.costBasis < 0.29, String(curve.costBasis));
  assert.ok(curve.onBoardKwh > BATTERY.usableKwh, String(curve.onBoardKwh));
  near(curve.onBoardFloor, curve.costBasis / 0.9 + 0.06 + 0.05);
  assert.ok(curve.onBoardFloor < 0.40, `${curve.onBoardFloor} is not well below 44 ct`);

  const morning = slotAt(curve, 8, 15);
  assert.ok(['peak', 'sell'].includes(colour(morning)), `08:15 is ${colour(morning)}`);
  for (let hour = 17; hour < 20; hour++) {
    for (const minute of [0, 15, 30, 45]) {
      const slot = slotAt(curve, hour, minute);
      assert.ok(['peak', 'sell'].includes(colour(slot)), `${hour}:${minute} is ${colour(slot)}`);
    }
  }
  // The cheap middle of the day stays out of it.
  assert.equal(colour(slotAt(curve, 13)), 'hold');
});

test('without a known cost the untracked charge is valued at the cheapest slot of the last day', async () => {
  const plan = await scenario().getPlan({ ...BATTERY, chargeCost: undefined }, at(20));
  near(plan.costBasis, 0.21);
  assert.equal(plan.costSource, 'fallback');
});

test('what tonight discharges is not counted again tomorrow', async () => {
  // A dear evening tonight: the plan spends part of the charge before midnight.
  const dearTonight = day(0.29, (hour) => (hour >= 20 && hour < 22 ? 0.45 : undefined));
  const prices = source({
    [TODAY]: quarters(DAY, dearTonight),
    [TOMORROW]: quarters(NEXT, TOMORROW_PRICES),
  });
  const curve = await prices.getCurve(BATTERY, at(20), 'tomorrow');
  assert.ok(curve.onBoardKwh < BATTERY.usableKwh, `${curve.onBoardKwh} was not reduced`);
});

test('the plan acts on the same floor the chart draws', async () => {
  // At 08:15 on the day itself, with the charge still on board.
  const prices = source({ [TOMORROW]: quarters(NEXT, TOMORROW_PRICES) });
  const when = NEXT + 8 * HOUR + 15 * MINUTE;
  const plan = await prices.getPlan(BATTERY, when);
  near(plan.dischargeFloor, 0.21 / 0.9 + 0.06 + 0.05);
  near(plan.newFloor, 0.331 / 0.9 + 0.06 + 0.05);
  assert.equal(plan.dischargeNow, true);
  assert.ok(plan.peakNow || plan.sellNow);

  const curve = await prices.getCurve(BATTERY, when, 'today');
  const slot = curve.hours.find((h) => h.now);
  assert.equal(slot.peak, plan.peakNow);
  assert.equal(slot.sell, plan.sellNow);
  assert.equal(slot.discharge, plan.dischargeNow);
});

test('a charge that cost more than a refill would is not held back for its own sake', async () => {
  const prices = source({ [TOMORROW]: quarters(NEXT, TOMORROW_PRICES) });
  const plan = await prices.getPlan({ ...BATTERY, chargeCost: 0.40 }, NEXT + 8 * HOUR + 15 * MINUTE);
  assert.equal(plan.onBoardFloor, null);
  near(plan.dischargeFloor, plan.newFloor);
});

// --- regression: without charge on board nothing changes ---------------------

test('without charge on board every verdict is the one a single floor gives', async () => {
  // An empty battery is only "without charge" today: tonight's buy moment
  // fills it for tomorrow (see the next test), so tomorrow is checked with the
  // charge unknown instead.
  for (const [options, days] of [
    [{ ...BATTERY, usableKwh: 0 }, ['today']],
    [{ ...BATTERY, usableKwh: undefined }, ['today', 'tomorrow']],
    [{ loadKw: 0.5 }, ['today', 'tomorrow']],
    [{}, ['today', 'tomorrow']],
  ]) {
    for (const dayName of days) {
      const curve = await scenario().getCurve(options, at(20), dayName);
      assert.equal(curve.onBoardFloor, null);

      // The verdicts of before: one floor for every slot, tomorrow unranked.
      const settings = { ...FrankPrices.DEFAULTS, ...options };
      const tomorrow = dayName === 'tomorrow';
      const rows = tomorrow ? quarters(NEXT, TOMORROW_PRICES) : quarters(DAY, TODAY_PRICES);
      const timeline = tomorrow ? rows : rows.concat(quarters(NEXT, TOMORROW_PRICES));
      if (tomorrow) settings.usableKwh = undefined;
      settings.netMeteringUntil = FrankPrices.NL_NET_METERING_END;
      const floor = curve.dischargeFloor;
      const nowIndex = tomorrow ? 0 : timeline.findIndex((row) => row.till > at(20));
      const ranking = FrankPrices._rank(timeline, nowIndex, settings, timeline.map(() => floor));
      const flags = FrankPrices._slotFlags(timeline, settings, { dischargeFloor: floor, nowIndex, ranking });
      assert.deepEqual(curve.hours.map((h) => [h.buy, h.sell, h.peak, h.discharge]),
        rows.map((row, i) => [flags.buy[i], flags.sell[i], flags.peak[i], row.price >= floor]),
        `${dayName} with ${JSON.stringify(options)}`);
    }
  }
});

test('an empty battery that buys tonight starts tomorrow with that charge, at that price', async () => {
  const curve = await scenario().getCurve({ ...BATTERY, usableKwh: 0, chargeCost: undefined }, at(20), 'tomorrow');
  // Bought at the 29 ct of tonight, towards the plan's charge target.
  near(curve.costBasis, 0.29);
  assert.ok(curve.onBoardKwh > 0);
  near(curve.onBoardFloor, 0.29 / 0.9 + 0.06 + 0.05);
});

test('one charge is never spent twice: selling and feeding the house share it', async () => {
  // 5 kWh on board, a 2 kW house and 5 kW selling: an evening of 12 dear
  // quarters cannot all be sold (that would take 15 kWh).
  const evening = day(0.20, (hour) => (hour >= 17 && hour < 20 ? 0.50 : undefined));
  const prices = source({ [TODAY]: quarters(DAY, evening) });
  const curve = await prices.getCurve({ usableKwh: 5, loadKw: 2, sellKw: 5, chargeCost: 0.20 }, at(16), 'today');
  let kwh = 0;
  for (const slot of curve.hours) {
    if (slot.sell) kwh += 5 * 0.25;
    else if (slot.peak && slot.from >= at(16)) kwh += 2 * 0.25;
  }
  // The use that exhausts the charge still counts, so at most one quarter over.
  assert.ok(kwh <= 5 + 5 * 0.25, `${kwh} kWh planned out of 5`);
});

// --- net metering -------------------------------------------------------------------

test('from 2027 an exported kWh earns the market price, not the all-in one', () => {
  const settings = { feedInPenalty: 0.05, exportFee: 0.01, netMeteringUntil: FrankPrices.NL_NET_METERING_END };
  const end = FrankPrices.NL_NET_METERING_END;
  const before = { from: end - QUARTER, price: 0.40, market: 0.15 };
  const after = { from: end, price: 0.40, market: 0.15 };
  near(FrankPrices.exportValue(before, settings), 0.35);
  near(FrankPrices.exportValue(after, settings), 0.14);
  // Outside the Netherlands nothing is netted at all.
  near(FrankPrices.exportValue(before, { ...settings, netMeteringUntil: -Infinity }), 0.14);
  // A contract that pays the export price including VAT; netted slots ignore it.
  near(FrankPrices.exportValue(after, { ...settings, exportVat: 0.21 }), 0.15 * 1.21 - 0.01);
  near(FrankPrices.exportValue(before, { ...settings, exportVat: 0.21 }), 0.35);
});

test('a dear quarter after net metering ends is no sell moment on the all-in price alone', async () => {
  // 2027-01-15: market 15 ct below the all-in price, as in every test day.
  const day2027 = Date.UTC(2027, 0, 14, 23);
  const evening = day(0.20, (hour) => (hour >= 17 && hour < 20 ? 0.45 : undefined));
  const prices = source({ '2027-01-15': quarters(day2027, evening) });
  const plan = await prices.getPlan({ usableKwh: 10, loadKw: 0.5 }, day2027 + 18 * HOUR);
  // 45 ct all-in clears the floor for the house, but 30 ct on the grid does not.
  assert.equal(plan.peakNow, true);
  assert.equal(plan.sellNow, false);
});

// --- the cost of the charge on board -------------------------------------------

const reading = (extra) => ({ now: MINUTE, batteryW: 4000, gridW: 4500, price: 0.21, exportValue: 0.10, usableKwh: 10, ...extra });

test('charging from the grid costs the all-in price', () => {
  // From an empty battery: the first charge sets the average.
  const state = ChargeCost.step({ avg: null, lastAt: 0 }, reading({ usableKwh: 0.05 }));
  near(state.avg, 0.21);
});

test('charging from the sun costs the export price it gave up', () => {
  const state = ChargeCost.step({ avg: null, lastAt: 0 }, reading({ gridW: -1000, usableKwh: 0.05 }));
  near(state.avg, 0.10);
  // Half from the grid, half from the sun.
  const mixed = ChargeCost.step({ avg: null, lastAt: 0 }, reading({ gridW: 2000, usableKwh: 0.05 }));
  near(mixed.avg, 0.155);
});

test('a new charge is weighed against what is already on board', () => {
  // 10 kWh at 30 ct on board, one minute at 4 kW (1/15 kWh) bought at 21 ct.
  const state = ChargeCost.step({ avg: 0.30, lastAt: 0 }, reading({ usableKwh: 10 }));
  const added = 4 / 60;
  near(state.avg, (0.30 * (10 - added) + 0.21 * added) / 10);
});

test('discharging leaves the average as it is', () => {
  const state = ChargeCost.step({ avg: 0.25, lastAt: 0 }, reading({ batteryW: -3000 }));
  assert.equal(state.avg, 0.25);
});

test('a gap, an unknown price or an unknown charge is not booked', () => {
  assert.equal(ChargeCost.step({ avg: 0.25, lastAt: 0 }, reading({ now: 11 * MINUTE })).avg, 0.25);
  assert.equal(ChargeCost.step({ avg: 0.25, lastAt: 0 }, reading({ price: null })).avg, 0.25);
  assert.equal(ChargeCost.step({ avg: 0.25, lastAt: 0 }, reading({ usableKwh: null })).avg, 0.25);
  // The first reading after a restart only starts the clock.
  const first = ChargeCost.step({ avg: 0.25, lastAt: null }, reading());
  assert.deepEqual(first, { avg: 0.25, lastAt: MINUTE });
});

test('an untracked charge on board is assumed to have cost the fallback', () => {
  const state = ChargeCost.step({ avg: null, lastAt: 0 }, reading({ usableKwh: 10, fallback: 0.30 }));
  const added = 4 / 60;
  near(state.avg, (0.30 * (10 - added) + 0.21 * added) / 10);
});

// --- the cheapest quarters --------------------------------------------------------

const EVENING_DEAR_NIGHT_CHEAP = {
  today: day(0.30, (hour) => (hour >= 18 && hour < 22 ? 0.25 : undefined)),
  tomorrow: day(0.30, (hour) => (hour >= 1 && hour < 4 ? 0.15 : undefined)),
};

test('the cheapest quarters until 07:00 are found in the night, not the evening', async () => {
  const prices = source({
    [TODAY]: quarters(DAY, EVENING_DEAR_NIGHT_CHEAP.today),
    [TOMORROW]: quarters(NEXT, EVENING_DEAR_NIGHT_CHEAP.tomorrow),
  });
  const now = at(15);
  const until = FrankPrices.nextClockTime(now, '07:00');
  assert.equal(until, NEXT + 7 * HOUR);
  const { chosen, known } = await prices.cheapestQuarters(12, until, now);
  assert.equal(known, 9 * 4 + 7 * 4);
  assert.equal(chosen.size, 12);
  for (const from of chosen) {
    assert.ok(from >= NEXT + 1 * HOUR && from < NEXT + 4 * HOUR, new Date(from).toISOString());
  }
});

test('a window into a tomorrow that is not published yet ranks the known quarters only', async () => {
  const prices = source({ [TODAY]: quarters(DAY, EVENING_DEAR_NIGHT_CHEAP.today) });
  const now = at(15);
  const until = FrankPrices.nextClockTime(now, '14:00');
  assert.equal(until, NEXT + 14 * HOUR);
  const { chosen, known } = await prices.cheapestQuarters(12, until, now);
  assert.equal(known, 9 * 4);
  for (const from of chosen) assert.ok(from >= at(18) && from < at(22));

  // Fewer known quarters than asked for: every known one is a yes. (A count of
  // its own: the same count and time would get the ranking above back.)
  const late = await prices.cheapestQuarters(40, FrankPrices.nextClockTime(at(23), '14:00'), at(23));
  assert.equal(late.known, 4);
  assert.equal(late.chosen.size, 4);
});

test('the quarters for an amount of energy are rounded up', () => {
  assert.equal(FrankPrices.quartersFor(20, 6.9), 12);
  assert.equal(FrankPrices.quartersFor(5, 6.9), 3);
  assert.equal(FrankPrices.quartersFor(5, 5), 4);
  assert.equal(FrankPrices.quartersFor(0, 6.9), 0);
  assert.equal(FrankPrices.quartersFor(-1, 6.9), 0);
});

test('of equal prices the earlier quarter wins, and the choice holds as time passes', async () => {
  const prices = source({ [TODAY]: quarters(DAY, new Array(96).fill(0.25)) });
  const until = FrankPrices.nextClockTime(at(15), '20:00');
  const first = await prices.cheapestQuarters(4, until, at(15, 5));
  assert.deepEqual([...first.chosen].sort(), [at(15), at(15, 15), at(15, 30), at(15, 45)]);

  // Asked again, and again after the chosen quarters are over: the same four,
  // not four new ones - a charger would otherwise never stop.
  const again = await prices.cheapestQuarters(4, until, at(15, 20));
  const later = await prices.cheapestQuarters(4, until, at(16, 10));
  assert.deepEqual([...again.chosen], [...first.chosen]);
  assert.deepEqual([...later.chosen], [...first.chosen]);
  assert.equal(later.chosen.has(FrankPrices.quarterStart(at(16, 10))), false);
});

test('new prices give a new ranking', async () => {
  const days = { [TODAY]: quarters(DAY, EVENING_DEAR_NIGHT_CHEAP.today) };
  const prices = source(days);
  const until = FrankPrices.nextClockTime(at(14), '07:00');
  const before = await prices.cheapestQuarters(4, until, at(14));
  for (const from of before.chosen) assert.ok(from >= at(18));

  // Tomorrow is published; the next ask (past the retry interval) sees the night.
  days[TOMORROW] = quarters(NEXT, EVENING_DEAR_NIGHT_CHEAP.tomorrow);
  const after = await prices.cheapestQuarters(4, until, at(14, 30));
  for (const from of after.chosen) assert.ok(from >= NEXT + HOUR && from < NEXT + 2 * HOUR);
});

test('a time earlier than now, or now itself, is tomorrow', () => {
  assert.equal(FrankPrices.nextClockTime(at(15, 7), '15:00'), NEXT + 15 * HOUR);
  assert.equal(FrankPrices.nextClockTime(at(15, 7), '16:00'), at(16));
  assert.equal(FrankPrices.nextClockTime(at(15, 7), '07:00'), NEXT + 7 * HOUR);
  assert.throws(() => FrankPrices.nextClockTime(at(15), '25:00'));
});

test('the plan names the cheapest quarter ahead, today or tomorrow', async () => {
  const prices = source({
    [TODAY]: quarters(DAY, EVENING_DEAR_NIGHT_CHEAP.today),
    [TOMORROW]: quarters(NEXT, EVENING_DEAR_NIGHT_CHEAP.tomorrow),
  });
  const plan = await prices.getPlan({}, at(15));
  near(plan.lowAhead, 0.15);
  assert.equal(plan.lowAheadFrom, NEXT + HOUR);
  assert.equal(FrankPrices.clockText(plan.lowAheadFrom), '01:00');
});
