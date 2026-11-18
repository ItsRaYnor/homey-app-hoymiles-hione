'use strict';

/**
 * Frank Energie day-ahead prices, and the trade decision that follows from them.
 *
 * A stored kWh only earns money when the day's spread covers the round trip:
 *
 *   return >= buy / efficiency + wear
 *
 * But "return" is not one number. A kWh the house eats avoids an import at the
 * full all-in price; a kWh that goes onto the grid earns the bare market price.
 * How far apart those two are depends entirely on the contract, and the answer
 * is not obvious — read a real invoice before assuming.
 *
 * Measured on this one: energy tax is levied on the year's NET import, so an
 * exported kWh takes a taxed kWh off the bill just as a self-consumed one does.
 * What is left between the two is only the supply and feed-in fees, a flat
 * amount per kWh rather than a share of the price. That is the feedInPenalty —
 * set it to what your own invoice shows. Net metering ends on 2027-01-01; from
 * then on an exported kWh earns the market price minus the exportFee, which
 * exportValue() switches to per slot.
 *
 * Everything here turns that one inequality into a handful of yes/no answers a
 * Flow can act on, so no Flow has to carry a hard-coded price threshold. Fixed
 * thresholds break on the days that matter: on a day where every hour is above
 * 23 ct the battery would never buy, and on a flat day it would trade all day
 * for nothing. The spread moves, so the thresholds have to move with it.
 *
 * Frank's public GraphQL endpoint needs no key. The all-in price is the sum of
 * the four components below, which matches what the Frank app shows to the cent.
 * Anyone can use it, not only Frank customers: the market price is the same for
 * every Dutch supplier, and a different markup shifts every slot by the same
 * amount, which the decisions above barely notice (~0.2 ct through efficiency).
 *
 * A day Frank cannot deliver is taken from dynamisch-tarief.nl instead (also
 * keyless, sourced from ENTSO-E). Its market price matched Frank's to the
 * hundred-thousandth for all 96 quarters checked; its all-in price carries the
 * average supplier markup, ~0.4 ct above Frank's. It only lists the slots from
 * the current quarter on, so it stands in for a day, it does not replace one:
 * a stored day stays as it is, and Frank is asked again every few minutes.
 *
 * All of the above is the Netherlands. Any other bidding zone takes the bare
 * day-ahead price from Energy-Charts instead (see MarketPrices) and adds the
 * user's own surcharge and VAT; the decisions are the same ones.
 */

const MarketPrices = require('./MarketPrices');

const ENDPOINT = 'https://frank-graphql-prod.graphcdn.app/';
const FALLBACK_ENDPOINT = 'https://www.dynamisch-tarief.nl/api/stroom/kwartierprijzen?uren=36';
const FALLBACK_NAME = 'dynamisch-tarief.nl';
const REQUEST_TIMEOUT_MS = 15000;

// Tomorrow is published around 13:00. Before that neither source has it, so
// asking the fallback every five minutes all morning would only be load on a
// hobby project; from this hour on a missing tomorrow means Frank is the problem.
const FALLBACK_TOMORROW_FROM_HOUR = 14;

// Energy-Charts limits requests per address, and the auction result is not out
// before about 13:00 anyway: outside the Netherlands tomorrow is not asked for
// before this hour, and a day that failed is retried at a slower pace.
const MARKET_TOMORROW_FROM_HOUR = 13;
const MARKET_RETRY_INTERVAL_MS = 15 * 60 * 1000;

// Day-ahead prices are Dutch market days, 00:00-24:00 Amsterdam time, and every
// "today" and "tomorrow" here means that day - never the clock of the process,
// which on Homey is UTC. hourCycle h23: some engines print midnight as "24".
const MARKET_TIME_ZONE = 'Europe/Amsterdam';
const MARKET_CLOCK = new Intl.DateTimeFormat('en-CA', {
  timeZone: MARKET_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

// Prices are published once a day and never change afterwards, so once the rows
// for the local day are in hand there is nothing left to ask for until midnight.
// The retry interval only governs a day we do NOT have yet.
const RETRY_INTERVAL_MS = 5 * 60 * 1000;

// Never aim a grid charge at the very top. The last few percent charge slowly,
// and leaving the room means the sun still has somewhere to go.
const MAX_CHARGE_TARGET_PCT = 95;

const DEFAULTS = {
  wearCost: 0.06,    // EUR/kWh, from the warranty throughput
  efficiency: 0.90,  // round trip
  minMargin: 0.05,   // EUR/kWh that must be left over before the battery moves
  buyBand: 0.02,     // buy within this much of the day low
  sellBand: 0.02,    // export within this much of the highest price still to come
  capacityKwh: 31.2, // usable pack energy across the full 0-100% span
  feedInPenalty: 0.0533, // EUR/kWh that exporting earns less than self-consuming, while netted
  exportFee: 0,       // EUR/kWh the supplier keeps off the market price, once nothing is netted
  exportVat: 0,       // VAT the supplier pays on top of the market price for an export (0.21), if any
  chargeKw: 5,        // what a buy moment is assumed to charge at, for tomorrow's starting charge
  floorSoc: 30,       // % the battery is allowed to discharge to
  sellKw: 5,          // what the battery delivers while selling; 0 = never plan to sell
};

// A slot this short or shorter is a quarter (or half) hour. One of them that
// falls just outside a buy, sell or peak run is bridged rather than obeyed: the
// battery would otherwise switch mode for fifteen minutes and back, which costs
// a register write each way and gains a fraction of a cent.
const BRIDGE_MAX_SLOT_MS = 30 * 60 * 1000;
const QUARTER_MS = 15 * 60 * 1000;

// Dutch net metering (salderen) ends by law on 2027-01-01 00:00, Amsterdam
// time. From then on an exported kWh earns the market price, not the all-in one.
const NL_NET_METERING_END = Date.UTC(2026, 11, 31, 23);

class FrankPrices {

  /**
   * @param {object} [options]
   * @param {{read: function(): object, write: function(object): *}} [options.store]
   *   Where fetched days survive a restart. Prices never change once published,
   *   so a restart during an internet outage can carry on with the day it
   *   already had instead of dropping every price decision until the line is
   *   back. Holds today and tomorrow only - a few kB.
   * @param {string} [options.zone] Bidding zone; 'NL' (the default) is Frank
   *   Energie, anything else the day-ahead market price for that zone.
   * @param {number} [options.surcharge] EUR/kWh added to the market price
   *   outside the Netherlands: taxes, grid fees and supplier markup, before VAT.
   * @param {number} [options.vat] VAT as a fraction (0.19), outside the
   *   Netherlands. Frank's prices already include it.
   * @param {{read: function(): object, write: function(object): *}} [options.rankStore]
   *   Where the cheapest-quarter rankings survive a restart.
   */
  constructor({ log, error, endpoint, fallbackEndpoint, marketEndpoint, store, rankStore, zone, surcharge, vat } = {}) {
    this.log = log || (() => {});
    this.error = error || (() => {});
    this._zone = zone || MarketPrices.FRANK_ZONE;
    this._frank = this._zone === MarketPrices.FRANK_ZONE;
    this._surcharge = Number.isFinite(surcharge) ? surcharge : 0;
    this._vat = Number.isFinite(vat) ? vat : 0;
    this._endpoint = endpoint || ENDPOINT;
    this._marketEndpoint = marketEndpoint || MarketPrices.ENDPOINT;
    // null switches the fallback off (tests); undefined means the default.
    // The fallback is a Dutch source, so no other zone has one.
    this._fallbackEndpoint = fallbackEndpoint === undefined ? FALLBACK_ENDPOINT : fallbackEndpoint;
    if (!this._frank) this._fallbackEndpoint = null;
    // What a day from the main source is called, in logs and in the store.
    this._primary = this._frank ? 'frank' : 'market';
    this._primaryName = this._frank ? 'Frank' : `Energy-Charts (${this._zone})`;
    this._retryMs = this._frank ? RETRY_INTERVAL_MS : MARKET_RETRY_INTERVAL_MS;
    // Stored days are only good for the zone and the surcharge they were
    // fetched with; a Dutch store carries no mark, as it never did.
    this._storeMark = this._frank ? null : `${this._zone}|${this._surcharge}|${this._vat}`;
    this._store = store || null;

    // One entry per local date: { rows, lastAttempt, source }. Only today and
    // tomorrow are ever asked for; past dates are dropped as the days roll over.
    this._cache = new Map();
    // One fallback answer covers today and tomorrow; kept for one retry interval
    // so both days are served by a single request.
    this._fallbackResponse = null;

    // The cheapest-quarter rankings, per (count, until); see cheapestQuarters.
    this._rankStore = rankStore || null;
    this._rankings = null;
  }

  /**
   * The day plan, or null when no prices could be obtained at all.
   * Never throws: a price outage must not take the battery poll down with it.
   */
  async getPlan(options = {}, now = Date.now()) {
    const analysis = await this._analyse(options, now);
    return analysis ? analysis.plan : null;
  }

  /**
   * The plan together with what it was worked out from: the timeline, where
   * "now" sits in it and the verdict for every slot. getPlan hands out only the
   * plan; getCurve needs the rest to draw the day and to carry the charge on
   * board over midnight. Null when there are no prices for now.
   */
  async _analyse(options, now) {
    let rows = await this._rowsFor(now);
    if (!rows || !rows.length) return null;
    // Tomorrow is published in the early afternoon and simply absent before.
    const tomorrow = await this._rowsFor(FrankPrices.nextDayStart(now), now) || [];

    const settings = this._settings(options);
    const slotNow = (row) => now >= row.from && now < row.till;
    // A day with a hole where "now" should be must not leave the last price
    // standing: patch the hole from the fallback, or plan nothing at all.
    if (!rows.some(slotNow)) rows = await this._patchFromFallback(now) || rows;
    const current = rows.find(slotNow);
    const ahead = rows.filter((row) => row.till > now);
    if (!current || !ahead.length) return null;

    const all = rows.map((row) => row.price);
    const dayLow = Math.min(...all);
    const dayHigh = Math.max(...all);
    const highAhead = Math.max(...ahead.map((row) => row.price));
    const tomorrowLow = tomorrow.length ? Math.min(...tomorrow.map((row) => row.price)) : null;

    // The day low is what the battery is (or will be) filled at, so it is the
    // reference for every sell decision — not the lowest price still to come,
    // which climbs as the day passes and would block the evening peak.
    // Once tomorrow is known its low counts as well: a kWh spent tonight is
    // bought back tomorrow, and on a cheap tomorrow holding it back earns
    // nothing. This can only lower the floor, never raise it.
    const referenceLow = tomorrowLow === null ? dayLow : Math.min(dayLow, tomorrowLow);
    const breakEven = referenceLow / settings.efficiency + settings.wearCost;
    // The floor for a kWh still to be bought. A kWh already on board is judged
    // against what it cost instead (see _judge), which can only be lower.
    const newFloor = breakEven + settings.minMargin;

    // "Today's spread" is kept for the Flow card and the flat-day verdict. It no
    // longer gates buying: a purchase is judged against the stretch it serves,
    // and that stretch can run past midnight (see _slotFlags).
    const buyFloor = dayLow / settings.efficiency + settings.wearCost + settings.minMargin;
    const spreadPays = dayHigh >= buyFloor;
    const marketHighAhead = Math.max(...ahead.map((row) => row.market));

    // Every decision below looks at one timeline - today and, once published,
    // tomorrow - instead of the calendar day. The calendar was the wrong cut: on
    // 2026-10-13 the cheapest quarter before a 57 ct morning was at 00:45, which
    // "today" could not see and "tomorrow" ruled out because tomorrow's midday
    // was cheaper still - although that midday came AFTER the morning it had to
    // pay for.
    const timeline = rows.concat(tomorrow);
    const index = timeline.indexOf(current);
    const cost = this._costBasis(settings, rows, now);
    settings.costBasis = cost.value;
    // The one place every verdict comes from: the chart colours, the Flow
    // conditions and the discharge floor tile all read this.
    const judged = FrankPrices._judge(timeline, index, settings, newFloor);
    const { flags, ranking } = judged;
    const dischargeFloor = judged.floors[index];
    const dischargeNow = current.price >= dischargeFloor;
    const buyNow = flags.buy[index];
    const sellNow = flags.sell[index];
    const peakNow = flags.peak[index];

    // How full is full enough? Charging to a fixed 95% buys whatever the battery
    // happens to have room for, not what the day will ask of it. Every slot that
    // clears the floor wants the house's draw for its length; every slot where
    // exporting clears it too wants what the battery delivers while selling.
    // Summed, that is a number of kWh, and that is a target. On a flat winter
    // day nothing clears the floor and the target falls to the floor itself —
    // which is the correct answer: do not buy at all. Solar still to come is
    // deliberately NOT subtracted; without a calibrated forecast that would be a
    // guess, and a wrong guess here is worse than the blunt instrument it
    // replaces.
    // Counted over what the next purchase has to cover: from the next buy
    // moment (this one, if it is one) to the cheaper refill after it.
    const buyAt = flags.buy.findIndex((isBuy, i) => i >= index && isBuy);
    // A bridged quarter is a buy only because its neighbours are, and the stretch
    // it opens itself ends at the cheaper neighbour after it - nothing to cover,
    // so the target fell to the floor for that one quarter and climbed back after
    // it: a stopped charge and two register writes (review 2026-10-27). Measure
    // from the run's next real buy instead; a bridge always has one right after.
    let stretchFrom = buyAt;
    while (stretchFrom !== -1 && !flags.buyRaw[stretchFrom]
        && flags.buy[stretchFrom + 1]) stretchFrom++;
    let chargeTarget = null;
    let energyNeededKwh = null;
    if (Number.isFinite(settings.loadKw) && settings.loadKw > 0
        && Number.isFinite(settings.capacityKwh) && settings.capacityKwh > 0) {
      const sellKw = Number.isFinite(settings.sellKw) ? settings.sellKw : 0;
      const from = buyAt === -1 ? index : buyAt;
      const until = buyAt === -1
        ? timeline.length
        : FrankPrices._stretchEnd(timeline, stretchFrom, timeline[stretchFrom].price - settings.buyBand);
      // What a purchase covers is energy still to be bought, so it is weighed
      // against the floor for new charge, not the one for the charge on board.
      energyNeededKwh = timeline.slice(from, until).reduce((sum, row) => {
        if (row.price < newFloor) return sum;
        const selling = sellKw > 0 && FrankPrices.exportValue(row, settings) >= newFloor;
        return sum + (selling ? Math.max(sellKw, settings.loadKw) : settings.loadKw)
          * FrankPrices.slotHours(row);
      }, 0);
      const span = energyNeededKwh / settings.capacityKwh * 100;
      chargeTarget = Math.round(Math.max(settings.floorSoc,
        Math.min(MAX_CHARGE_TARGET_PCT, settings.floorSoc + span)));
    }

    // Holding a kWh through a quiet hour only pays when that kWh cannot be
    // bought back more cheaply before the hour it is being kept for. The dearest
    // hour ahead is what the holding protects; if any hour before it refills
    // below what the energy is worth right now, holding is the worse trade -
    // spend it now and buy it back in the dip. Without this an overnight stretch
    // at 35 ct parks the battery to serve a 45 ct evening that the 17 ct
    // afternoon in between would have filled for a third of the price.
    // Tomorrow belongs in this window too: after tonight's peak the dearest
    // hour ahead is tomorrow evening, with tomorrow's dip in front of it.
    const horizon = ahead.concat(tomorrow);
    const peakIdxAhead = horizon.reduce(
      (best, row, i) => (row.price > horizon[best].price ? i : best), 0,
    );
    const refillCost = (price) => price / settings.efficiency + settings.wearCost;
    const cheaperRefillAhead = horizon
      .slice(0, peakIdxAhead)
      .some((row) => refillCost(row.price) < current.price);

    // A flat today no longer means nothing to do: against a dear tomorrow there
    // can be something to buy, and against a cheap one something to discharge.
    let action = 'hold';
    if (buyNow) action = 'buy';
    else if (sellNow) action = 'sell';
    else if (peakNow) action = 'discharge';
    else if (dischargeNow) action = 'save';
    else if (!spreadPays) action = 'flat';

    // The cheapest known quarter from now on, today or tomorrow, the earliest
    // of equals: what "wait for x" waits for.
    let lowIdx = index;
    for (let i = index + 1; i < timeline.length; i++) {
      if (timeline[i].price < timeline[lowIdx].price) lowIdx = i;
    }

    const plan = {
      priceNow: current.price,
      marketNow: current.market,
      from: current.from,
      till: current.till,
      dayLow,
      dayHigh,
      tomorrowLow,
      referenceLow,
      highAhead,
      marketHighAhead,
      breakEven,
      dischargeFloor,
      newFloor,
      onBoardFloor: judged.board ? judged.board.floor : null,
      costBasis: cost.value,
      costSource: cost.source,
      lowAhead: timeline[lowIdx].price,
      lowAheadFrom: timeline[lowIdx].from,
      spreadPays,
      buyNow,
      dischargeNow,
      peakNow,
      sellNow,
      cheaperRefillAhead,
      hoursCovered: ranking ? FrankPrices._sumHours(ranking.houseRows) : null,
      slotMinutes: Math.round(FrankPrices.slotHours(current) * 60),
      chargeTarget,
      energyNeededKwh,
      nextBuyPrice: buyAt === -1 ? null : timeline[buyAt].price,
      nextBuyFrom: buyAt === -1 ? null : timeline[buyAt].from,
      action,
      source: this._sourceFor(now),
    };
    return { plan, settings, rows, timeline, index, judged };
  }

  /** What a kWh exported in slot `row` earns with these options, EUR/kWh. */
  exportValueOf(row, options) {
    return FrankPrices.exportValue(row, this._settings(options));
  }

  /** The defaults, the caller's options, and when this zone stops netting. */
  _settings(options) {
    const settings = { ...DEFAULTS, ...options };
    if (settings.netMeteringUntil === undefined) {
      settings.netMeteringUntil = this._frank ? NL_NET_METERING_END : -Infinity;
    }
    return settings;
  }

  /**
   * What a kWh on board cost, in EUR/kWh: the tracked average when the device
   * keeps one, otherwise the cheapest slot of the last 24 hours - the price it
   * was most likely bought at. Null when neither is known.
   */
  _costBasis(settings, rows, now) {
    if (Number.isFinite(settings.chargeCost)) return { value: settings.chargeCost, source: 'tracked' };
    const since = now - 24 * 3600 * 1000;
    const seen = (this._previousRows || []).concat(rows)
      .filter((row) => row.from >= since && row.from <= now);
    if (!seen.length) return { value: null, source: null };
    return { value: Math.min(...seen.map((row) => row.price)), source: 'fallback' };
  }

  /**
   * The charge above the floor at midnight, and what it cost: what is on board
   * now, played forward through tonight's verdicts. A peak spends the house
   * load, a sale what the battery sells at; a buy moment charges towards the
   * plan's charge target at the assumed charge power, at that quarter's price.
   * Null when the charge or the house load is not known.
   */
  static _chargeAtMidnight({ settings, rows, timeline, index, judged, plan }, now) {
    const { usableKwh, loadKw } = settings;
    if (!Number.isFinite(usableKwh) || !Number.isFinite(loadKw) || loadKw <= 0) return null;
    const sellKw = Number.isFinite(settings.sellKw) ? settings.sellKw : 0;
    const targetKwh = plan && Number.isFinite(plan.chargeTarget)
      ? Math.max(0, (plan.chargeTarget - settings.floorSoc) / 100 * settings.capacityKwh)
      : null;
    let kwh = usableKwh;
    let cost = settings.costBasis;
    for (let i = index; i < rows.length; i++) {
      const row = timeline[i];
      const hours = (row.till - Math.max(row.from, now)) / 3600000;
      if (judged.flags.buy[i] && targetKwh !== null && kwh < targetKwh) {
        const added = Math.min(targetKwh - kwh, settings.chargeKw * hours);
        cost = Number.isFinite(cost) && kwh > 0 ? (cost * kwh + row.price * added) / (kwh + added) : row.price;
        kwh += added;
      } else if (judged.flags.sell[i]) {
        kwh -= Math.max(sellKw, loadKw) * hours;
      } else if (judged.flags.peak[i]) {
        kwh -= loadKw * hours;
      }
      kwh = Math.max(0, kwh);
    }
    return { kwh, cost };
  }

  /**
   * The whole day, hour by hour, with the verdict the plan would give at each
   * hour. Insights can only ever draw what a value was at the moment it was
   * recorded, so it cannot show the hours still to come; this can, because the
   * day is already in hand after one fetch.
   */
  async getCurve(options = {}, now = Date.now(), day = 'today') {
    const isTomorrow = day === 'tomorrow';
    let rows = isTomorrow
      ? await this._rowsFor(FrankPrices.nextDayStart(now), now)
      : await this._rowsFor(now);
    if (!rows || !rows.length) return null;

    // Today's analysis is wanted either way: for today it is the plan itself,
    // for tomorrow it says how much charge is left over at midnight.
    const analysis = await this._analyse(options, now);
    const plan = analysis ? analysis.plan : null;
    // The plan may have patched a hole in today from the fallback; draw those rows.
    if (!isTomorrow && analysis) rows = analysis.rows;
    const settings = this._settings(options);
    const all = rows.map((row) => row.price);
    const dayLow = Math.min(...all);
    const dayHigh = Math.max(...all);
    // Today draws the same floor the plan acts on. For tomorrow the day after
    // is not known, so its own low is the only reference there is.
    const referenceLow = plan && !isTomorrow ? plan.referenceLow : dayLow;
    const breakEven = referenceLow / settings.efficiency + settings.wearCost;
    const newFloor = breakEven + settings.minMargin;
    const spreadPays = dayHigh >= dayLow / settings.efficiency + settings.wearCost + settings.minMargin;
    settings.costBasis = plan ? plan.costBasis : this._costBasis(settings, rows, now).value;

    let timeline;
    let nowIndex;
    let judged;
    if (isTomorrow) {
      // Tomorrow as it will stand at midnight: no slot is current and there is
      // no live plan, but the battery does not start empty. What the plan
      // leaves over tonight is ranked over tomorrow's dearest slots against
      // what it cost; without that charge (or without knowing it) tomorrow is
      // judged on its own, as before.
      const start = analysis ? FrankPrices._chargeAtMidnight(analysis, now) : null;
      settings.usableKwh = start && start.kwh > 0 ? start.kwh : undefined;
      if (start && Number.isFinite(start.cost)) settings.costBasis = start.cost;
      timeline = rows;
      nowIndex = 0;
      judged = FrankPrices._judge(timeline, nowIndex, settings, newFloor);
    } else if (analysis) {
      // Today is judged against tomorrow too, exactly as the plan does - it IS
      // the plan's own verdict, so the chart shows what the Flows will get.
      ({ timeline, judged } = analysis);
      nowIndex = analysis.index;
    } else {
      // No price for now (a hole in the day): draw what there is, unranked.
      timeline = rows.concat(await this._rowsFor(FrankPrices.nextDayStart(now), now) || []);
      nowIndex = Math.max(0, timeline.findIndex((row) => row.till > now));
      judged = FrankPrices._judge(timeline, nowIndex, settings, newFloor);
    }
    const { flags, floors, ranking } = judged;

    // Still called "hours" because the settings page reads it by that name;
    // since Frank's quarter-hour prices each entry is fifteen minutes.
    const hours = rows.map((row, index) => ({
      from: row.from,
      till: row.till,
      price: row.price,
      market: row.market,
      buy: flags.buy[index],
      discharge: row.price >= floors[index],
      peak: flags.peak[index],
      sell: flags.sell[index],
      now: now >= row.from && now < row.till,
    }));

    return {
      day: isTomorrow ? 'tomorrow' : 'today',
      date: FrankPrices.localDate(new Date(rows[0].from)),
      hours,
      plan: isTomorrow ? null : plan,
      dayLow,
      dayHigh,
      referenceLow,
      marketHigh: Math.max(...rows.map((row) => row.market)),
      breakEven,
      // The line for charge still to be bought; the one for the charge on
      // board is drawn as well when it is lower and there is charge to use it.
      dischargeFloor: newFloor,
      newFloor,
      onBoardFloor: judged.board ? judged.board.floor : null,
      onBoardKwh: judged.board ? settings.usableKwh : null,
      costBasis: settings.costBasis,
      costSource: plan ? plan.costSource : null,
      spreadPays,
      hoursCovered: ranking ? FrankPrices._sumHours(ranking.houseRows) : null,
      slotMinutes: Math.round(FrankPrices.slotHours(rows[0]) * 60),
      source: this._sourceFor(isTomorrow ? FrankPrices.nextDayStart(now) : now),
    };
  }
  /**
   * Cached rows for the local day `when` falls in, fetching when needed.
   * `now` is the real clock and paces the retries; it only differs from
   * `when` when asking for tomorrow.
   */
  async _rowsFor(when, now = when) {
    const date = FrankPrices.localDate(new Date(when));
    const today = FrankPrices.localDate(new Date(now));
    for (const key of [...this._cache.keys()]) {
      if (key >= today) continue;
      // Kept in memory for one more day: the cheapest slot of the last 24 hours
      // is what an untracked charge on board is assumed to have cost.
      const old = this._cache.get(key);
      if (old && old.rows) this._previousRows = old.rows;
      this._cache.delete(key);
    }

    let entry = this._cache.get(date);
    if (!entry) {
      entry = { rows: null, lastAttempt: 0, source: null, standIn: null };
      this._cache.set(date, entry);
    }
    // A day from the fallback is kept but not final: Frank is still asked.
    if (entry.rows && entry.source !== 'fallback') return entry.rows;

    if (!entry.rows) {
      // A day fetched before the last restart is as good as a fresh one -
      // unless it was stored in whole hours, before quarter-hour prices. That
      // day is fetched again, and the hourly copy only stands in while the
      // fetch fails.
      const saved = this._savedRows(date);
      const savedHourly = saved && saved.some((row) => row.till - row.from > BRIDGE_MAX_SLOT_MS);
      const savedSource = this._savedSource(date);
      // Before 1.1.9 a Frank day was stored without its first two hours (see
      // localDate); such a day is fetched again, like an hourly one.
      const savedShort = saved && savedSource !== 'fallback' && !FrankPrices._coversDay(saved, date);
      if (saved && !savedHourly && !savedShort) {
        entry.rows = saved;
        entry.source = savedSource;
        this.log(`[Prices] ${saved.length} prices for ${date} from storage`
          + (savedSource === 'fallback' ? ` (${FALLBACK_NAME})` : ''));
        if (savedSource !== 'fallback') return saved;
      } else {
        entry.standIn = saved;
      }
    }

    const current = entry.rows || entry.standIn || null;
    if (now - entry.lastAttempt < this._retryMs) return current;
    // Not published yet, and no reason to ask a rate-limited source to say so.
    if (!this._frank && date !== today
        && FrankPrices.localHour(now) < MARKET_TOMORROW_FROM_HOUR) return current;

    entry.lastAttempt = now;
    let frankError;
    try {
      // Asked for a day that is not published yet, the endpoint may answer
      // with nothing or with neighbouring hours; only the day itself counts.
      const rows = (await this._fetch(date))
        .filter((row) => FrankPrices.localDate(new Date(row.from)) === date);
      if (!rows.length) throw new Error('no prices returned');
      if (entry.source === 'fallback') this.log(`[Prices] Frank is back for ${date}`);
      entry.rows = rows;
      entry.source = this._primary;
      entry.standIn = null;
      this.log(`[Prices] ${rows.length} prices for ${date}`);
      this._saveRows(today);
      return rows;
    } catch (err) {
      frankError = err;
    }

    // Tomorrow is not out until the early afternoon. That is the normal state
    // of affairs, not something to log every five minutes - or to send the
    // fallback after, which does not have it either.
    const isToday = date === today;
    if (isToday) this.error(`${this._primaryName} prices failed: ${frankError.message}`);
    if (!isToday && FrankPrices.localHour(now) < FALLBACK_TOMORROW_FROM_HOUR) return current;

    const backup = await this._fallbackRows(date, now);
    if (!backup || !backup.length) return current;

    // The fallback starts at the current quarter, so each answer is shorter
    // than the one before. Merge rather than replace, or the morning's slots -
    // and with them the day low every decision is measured against - would
    // drain away over the day.
    const known = entry.source === 'fallback' ? entry.rows : null;
    const merged = FrankPrices._mergeRows(known, backup);
    if (entry.source !== 'fallback') {
      this.log(`[Prices] ${merged.length} prices for ${date} from ${FALLBACK_NAME}`
        + ` (Frank: ${frankError.message})`);
    }
    entry.rows = merged;
    entry.source = 'fallback';
    entry.standIn = null;
    this._saveRows(today);
    return merged;
  }

  /**
   * Fill today's rows from the fallback when they lack the current slot.
   * Returns the patched rows, or null when the fallback cannot help either.
   * The day is then marked as a fallback day, so Frank is asked again and
   * replaces it whole once it delivers.
   */
  async _patchFromFallback(now) {
    const date = FrankPrices.localDate(new Date(now));
    const entry = this._cache.get(date);
    if (!entry || !entry.rows) return null;
    const backup = await this._fallbackRows(date, now);
    if (!backup || !backup.some((row) => now >= row.from && now < row.till)) return null;
    this.log(`[Prices] no price for now in the ${date} rows - patched from ${FALLBACK_NAME}`);
    // Frank's slots win where they exist; the fallback only fills the hole.
    entry.rows = FrankPrices._mergeRows(backup, entry.rows);
    // Frank is asked again at the normal retry pace, not on the very next call:
    // while its day keeps the hole, an immediate retry got the same hole back and
    // every Flow condition that read the plan cost a request and two store writes.
    entry.source = 'fallback';
    this._saveRows(date);
    return entry.rows;
  }

  /** Where the rows for the local day `when` falls in came from, if known. */
  _sourceFor(when) {
    const entry = this._cache.get(FrankPrices.localDate(new Date(when)));
    return (entry && entry.rows && entry.source) || null;
  }

  /**
   * The fallback's rows for `date`, or null. One request serves both days for
   * a retry interval; a failure is logged and never thrown.
   */
  async _fallbackRows(date, now) {
    if (!this._fallbackEndpoint) return null;
    let response = this._fallbackResponse;
    if (!response || now - response.at >= RETRY_INTERVAL_MS) {
      try {
        response = { at: now, rows: await this._fetchFallback() };
      } catch (err) {
        response = { at: now, rows: [] };
        this.error(`${FALLBACK_NAME} prices failed: ${err.message}`);
      }
      this._fallbackResponse = response;
    }
    return response.rows.filter((row) => FrankPrices.localDate(new Date(row.from)) === date);
  }

  async _fetchFallback() {
    const payload = await this._getJson(this._fallbackEndpoint, { headers: { Accept: 'application/json' } });
    const rows = payload && payload.prices;
    if (!Array.isArray(rows) || !rows.length) throw new Error('no prices returned');
    return rows
      .map((row) => ({
        from: new Date(row.from).getTime(),
        till: new Date(row.till).getTime(),
        // `price` includes the average supplier markup; `market_price` is the
        // bare day-ahead price, the same figure Frank calls marketPrice.
        price: row.price,
        market: row.market_price,
      }))
      .filter((row) => Number.isFinite(row.from) && Number.isFinite(row.till)
        && Number.isFinite(row.price) && Number.isFinite(row.market))
      .sort((a, b) => a.from - b.from);
  }

  /** True when `rows` run from 00:00 to 24:00 of market day `date`. */
  static _coversDay(rows, date) {
    if (!rows.length) return false;
    const first = rows[0].from;
    const last = rows[rows.length - 1].till;
    const atMidnight = (ms) => {
      const p = FrankPrices._zoneParts(ms);
      return p.hour === '00' && p.minute === '00';
    };
    return FrankPrices.localDate(new Date(first)) === date && atMidnight(first)
      && FrankPrices.localDate(new Date(last)) !== date && atMidnight(last);
  }

  /** Union of two row lists by start time; the newer list wins on overlap. */
  static _mergeRows(older, newer) {
    const byFrom = new Map();
    for (const row of older || []) byFrom.set(row.from, row);
    for (const row of newer) byFrom.set(row.from, row);
    return [...byFrom.values()].sort((a, b) => a.from - b.from);
  }

  /** Rows stored for `date`, or null when absent or not trustworthy. */
  _savedRows(date) {
    if (!this._store) return null;
    let saved;
    try {
      saved = this._store.read();
    } catch (err) {
      return null;
    }
    // A day fetched for another zone, or priced with another surcharge, is
    // somebody else's day.
    if (((saved && saved.zone) || null) !== this._storeMark) return null;
    const rows = saved && saved[date];
    if (!Array.isArray(rows) || !rows.length) return null;
    const valid = rows.every((row) => row
      && Number.isFinite(row.from) && Number.isFinite(row.till)
      && Number.isFinite(row.price) && Number.isFinite(row.market)
      && FrankPrices.localDate(new Date(row.from)) === date);
    return valid ? rows : null;
  }

  /** 'fallback' when the stored day came from the fallback, else the main source. */
  _savedSource(date) {
    if (!this._store) return this._primary;
    try {
      const saved = this._store.read();
      return saved && saved.sources && saved.sources[date] === 'fallback' ? 'fallback' : this._primary;
    } catch (err) {
      return this._primary;
    }
  }

  /** Persist the cached days from `today` on; older ones are left behind. */
  _saveRows(today) {
    if (!this._store) return;
    const out = {};
    const sources = {};
    for (const [date, entry] of this._cache) {
      if (date >= today && entry.rows) {
        out[date] = entry.rows;
        if (entry.source === 'fallback') sources[date] = 'fallback';
      }
    }
    // Under a key no date can collide with; stores written before it existed
    // simply have no sources, which reads as Frank.
    if (Object.keys(sources).length) out.sources = sources;
    if (this._storeMark) out.zone = this._storeMark;
    try {
      Promise.resolve(this._store.write(out))
        .catch((err) => this.error('Could not store prices: ' + err.message));
    } catch (err) {
      this.error('Could not store prices: ' + err.message);
    }
  }

  async _fetch(date) {
    if (!this._frank) {
      const payload = await this._getJson(
        MarketPrices.urlFor(this._zone, date, this._marketEndpoint),
        { headers: { Accept: 'application/json' } },
      );
      return MarketPrices.parse(payload, { surcharge: this._surcharge, vat: this._vat });
    }

    // Frank retired marketPricesElectricity(startDate, endDate) in late September
    // 2026; it now fails validation. marketPrices(date) returns the local day
    // (00:00-24:00 Amsterdam), and in quarter hours on request - the resolution
    // the day-ahead market itself now settles in. Within one hour the price can
    // run from 43 to 60 ct, so the plan buys and sells per quarter. Everything
    // downstream weighs a slot by its length, so an hourly day stored before
    // this change still plans correctly until it rolls off.
    const query = `{ marketPrices(date: "${date}", resolution: PT15M) { electricityPrices {`
      + ' from till marketPrice marketPriceTax sourcingMarkupPrice energyTaxPrice } } }';

    const payload = await this._getJson(this._endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });

    if (payload && payload.errors && payload.errors.length) {
      throw new Error(payload.errors[0].message || 'GraphQL error');
    }
    const prices = payload && payload.data && payload.data.marketPrices;
    const rows = prices && prices.electricityPrices;
    if (!Array.isArray(rows) || !rows.length) throw new Error('no prices returned');

    return rows
      .map((row) => ({
        from: new Date(row.from).getTime(),
        till: new Date(row.till).getTime(),
        // price = what importing costs; market = what exporting earns.
        price: row.marketPrice + row.marketPriceTax + row.sourcingMarkupPrice + row.energyTaxPrice,
        market: row.marketPrice,
      }))
      .filter((row) => Number.isFinite(row.from) && Number.isFinite(row.price))
      .sort((a, b) => a.from - b.from);
  }

  /** fetch() with a timeout; resolves to the parsed JSON body. */
  async _getJson(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Length of a price slot in hours: 0.25 for a quarter, 1 for an hour. */
  static slotHours(row) {
    return (row.till - row.from) / 3600000;
  }

  /** Total length of some slots in hours, to the quarter. */
  static _sumHours(slots) {
    const hours = slots.reduce((sum, row) => sum + FrankPrices.slotHours(row), 0);
    return Math.round(hours * 4) / 4;
  }

  /**
   * What a kWh leaving the battery for the grid earns in slot `row`, EUR/kWh.
   *
   * While the Netherlands nets exports against imports (until 2027-01-01), an
   * exported kWh takes a taxed kWh off the bill, so it is worth the all-in
   * price minus only the fees: `feedInPenalty`. Without netting - every other
   * zone, and the Netherlands from 2027 - it earns the bare market price, plus
   * VAT when the contract pays the export price including VAT (`exportVat`),
   * minus whatever the supplier keeps per exported kWh (`exportFee`). The
   * switch is per slot, so the night of 31 December is judged right on both
   * sides.
   */
  static exportValue(row, settings) {
    const netted = Number.isFinite(settings.netMeteringUntil) && row.from < settings.netMeteringUntil;
    // A row without a market price (a source that only gives all-in prices)
    // can only be judged the netted way.
    return netted || !Number.isFinite(row.market)
      ? row.price - settings.feedInPenalty
      : row.market * (1 + (Number.isFinite(settings.exportVat) ? settings.exportVat : 0))
        - (Number.isFinite(settings.exportFee) ? settings.exportFee : 0);
  }

  /**
   * Where the stretch that slot `i` opens ends: the first later slot priced
   * below `below`, or the end of what is known. Day boundaries play no part -
   * the night between a dear morning and the cheap midday after it is one
   * stretch, whatever the calendar says.
   */
  static _stretchEnd(timeline, i, below) {
    for (let k = i + 1; k < timeline.length; k++) {
      if (timeline[k].price < below) return k;
    }
    return timeline.length;
  }

  /**
   * The first slot after `i` where a kWh can be bought back for less than
   * `worth` (round trip and wear included), or the end of what is known.
   * Energy spent before that slot competes for the same charge; energy spent
   * after it comes out of a refill.
   */
  static _refillEnd(timeline, i, worth, settings) {
    for (let k = i + 1; k < timeline.length; k++) {
      if (timeline[k].price / settings.efficiency + settings.wearCost < worth) return k;
    }
    return timeline.length;
  }

  /**
   * How the charge on board is best spent, from the current slot up to where
   * a refill takes over. Null when the charge is not known, which means "do
   * not rank" rather than "spend nothing" - an unknown must never stop the
   * battery working.
   *
   * One budget for both ways a kWh can go. It used to be two rankings that
   * each spent the whole charge, so a day could be planned to sell 20 kWh out
   * of 17.8 and feed the house from the same kWh as well. Now every slot that
   * clears its floor offers two uses, and the charge goes to the best value
   * per kWh first until it is spent:
   *
   * - the house:  loadKw for the length of the slot, worth the import price;
   * - the grid:   what selling adds on top (sellKw - loadKw), worth the export
   *               value - only where that clears the floor too.
   *
   * A slot sells when its grid use got charge; it is a peak when its house use
   * did. Counted in energy, not in slots, and the use that exhausts the charge
   * still counts, as a whole hour always did. Without a house load (unknown)
   * the house uses cost nothing, which ranks only the selling - as before.
   *
   * Returns { until, house: Set, sell: Set, houseRows } with slot start times.
   */
  static _rank(timeline, nowIndex, settings, floors) {
    const current = timeline[nowIndex];
    const { usableKwh } = settings;
    if (!current || !Number.isFinite(usableKwh)) return null;
    const loadKw = Number.isFinite(settings.loadKw) && settings.loadKw > 0.1 ? settings.loadKw : 0;
    const sellKw = Number.isFinite(settings.sellKw) ? settings.sellKw : 0;
    const until = FrankPrices._refillEnd(timeline, nowIndex, current.price, settings);

    const uses = [];
    for (let i = nowIndex; i < until; i++) {
      const row = timeline[i];
      if (row.price < floors[i]) continue;
      const hours = FrankPrices.slotHours(row);
      uses.push({ row, grid: false, value: row.price, kwh: loadKw * hours });
      const exported = FrankPrices.exportValue(row, settings);
      if (sellKw > 0 && exported >= floors[i]) {
        uses.push({ row, grid: true, value: exported, kwh: Math.max(0, sellKw - loadKw) * hours });
      }
    }
    // Best value first; of equals the house before the grid, the earlier first.
    uses.sort((a, b) => b.value - a.value || a.grid - b.grid || a.row.from - b.row.from);

    const house = new Set();
    const sell = new Set();
    const houseRows = [];
    let spent = 0;
    for (const use of uses) {
      // Selling a slot means discharging in it, so its house use comes along.
      const houseKwh = house.has(use.row.from) ? 0 : loadKw * FrankPrices.slotHours(use.row);
      const kwh = houseKwh + (use.grid ? use.kwh : 0);
      // The charge is spent; a use that needs none (no house load) still fits.
      if (kwh > 0 && spent >= usableKwh) continue;
      if (!house.has(use.row.from)) {
        house.add(use.row.from);
        houseRows.push(use.row);
      }
      if (use.grid) sell.add(use.row.from);
      spent += kwh;
    }
    return { until, house, sell, houseRows };
  }

  /**
   * Buy, sell and peak verdicts for every slot of a timeline (today, plus
   * tomorrow once known), in order.
   *
   * - Buy: no slot before the stretch's dear part is cheaper by more than the
   *   buy band, and that stretch - up to the next cheaper slot - holds a slot
   *   worth more than the purchase costs (round trip, wear and margin).
   * - Sell: exporting clears the floor, and within the ranked stretch the
   *   charge on board was given to this slot's export (see _rank). Outside it,
   *   or with the charge unknown, it must be within the sell band of the best
   *   price still to come before a refill. Never with a sell power of 0.
   * - Peak: discharging clears the floor and, within the ranked stretch, the
   *   charge on board was given to this slot.
   *
   * With quarter-hour prices a run of buy or sell slots is often broken by a
   * single quarter just outside it; flipping the battery for that one quarter
   * costs two register writes to gain a fraction of a cent, so such a gap is
   * bridged - but never into a trade that loses money: a bridged buy must stay
   * within twice the band of its neighbours, a bridged sale must still clear
   * the floor after the export penalty, and a bridged peak must still clear it.
   */
  static _slotFlags(timeline, settings, { dischargeFloor, nowIndex = 0, ranking = null }) {
    const n = timeline.length;
    // One floor per slot: lower where the charge on board is spent (see _judge).
    const floors = Array.isArray(dischargeFloor) ? dischargeFloor : timeline.map(() => dischargeFloor);
    const selling = Number.isFinite(settings.sellKw) ? settings.sellKw > 0 : true;
    const sellClears = (row, i) => selling && FrankPrices.exportValue(row, settings) >= floors[i];
    const ranked = (i) => ranking && i >= nowIndex && i < ranking.until;

    // A slot dear enough to discharge into is never one to buy in: the two
    // verdicts would send the battery opposite ways in the same quarter.
    const buy = timeline.map((row, i) => {
      if (row.price >= floors[i]) return false;
      const end = FrankPrices._stretchEnd(timeline, i, row.price - settings.buyBand);
      let dearest = -Infinity;
      for (let k = i + 1; k < end; k++) dearest = Math.max(dearest, timeline[k].price);
      return dearest >= row.price / settings.efficiency + settings.wearCost + settings.minMargin;
    });

    const sell = timeline.map((row, i) => {
      if (!sellClears(row, i)) return false;
      if (ranked(i)) return ranking.sell.has(row.from);
      const end = FrankPrices._refillEnd(timeline, i, FrankPrices.exportValue(row, settings), settings);
      let best = row.price;
      for (let k = i + 1; k < end; k++) best = Math.max(best, timeline[k].price);
      return row.price >= best - settings.sellBand;
    });

    const peak = timeline.map((row, i) => row.price >= floors[i]
      && (!ranked(i) || ranking.house.has(row.from)));

    const bridge = (raw, allowed) => raw.map((value, i) => value || (
      i > 0 && i < n - 1 && raw[i - 1] && raw[i + 1]
      && timeline[i].till - timeline[i].from <= BRIDGE_MAX_SLOT_MS
      && allowed(timeline[i], i)));

    return {
      // The unbridged verdict, for the charge target: a bridged quarter's own
      // stretch ends at the cheaper neighbour right after it.
      buyRaw: buy,
      buy: bridge(buy, (row, i) => row.price < floors[i] && row.price
        <= Math.min(timeline[i - 1].price, timeline[i + 1].price) + 2 * settings.buyBand),
      sell: bridge(sell, sellClears),
      peak: bridge(peak, (row, i) => row.price >= floors[i]),
    };
  }

  /**
   * Every verdict for every slot of a timeline, from one floor per slot.
   *
   * Two kinds of kWh are judged here. One still to be bought has to beat the
   * cheapest price it can be bought at: `newFloor`, from the day low. One that
   * is already on board has been paid for, and has to beat only what it cost:
   *
   *   onBoardFloor = cost / efficiency + wear + margin
   *
   * Judging the charge on board against tomorrow's low made a 21 ct charge sit
   * through a whole day of 33-44 ct (2026-11-18), because tomorrow's own low
   * put the floor at 47.7 ct. The lower floor holds from now until that charge
   * is spent or a cheaper refill takes over - the window the ranking counts
   * the charge in, so it is never spent twice. After it, a slot is served by
   * new charge and the new floor applies again.
   *
   * The lower of the two always wins: a charge that cost more than a refill
   * would is not held back for its own sake. Without charge above the floor, or
   * without a cost, every slot gets the new floor.
   */
  static _judge(timeline, nowIndex, settings, newFloor) {
    const board = FrankPrices._onBoard(timeline, nowIndex, settings, newFloor);
    const floors = timeline.map((row, i) => (board && i >= nowIndex && i < board.until
      ? board.floor : newFloor));
    const ranking = FrankPrices._rank(timeline, nowIndex, settings, floors);
    const flags = FrankPrices._slotFlags(timeline, settings, { dischargeFloor: floors, nowIndex, ranking });
    return { floors, board, ranking, flags, newFloor };
  }

  /**
   * The floor for the charge on board and the slot it stops applying at, or
   * null when it does not apply: no charge above the floor, no known cost, or
   * a cost that would not lower the floor anyway.
   */
  static _onBoard(timeline, nowIndex, settings, newFloor) {
    const { costBasis, usableKwh } = settings;
    const current = timeline[nowIndex];
    if (!current || !Number.isFinite(costBasis)) return null;
    if (!Number.isFinite(usableKwh) || usableKwh <= 0) return null;
    const floor = costBasis / settings.efficiency + settings.wearCost + settings.minMargin;
    if (floor >= newFloor) return null;
    // Up to where the ranking stops counting this charge, and never past a slot
    // that refills it for less than it cost.
    const houseEnd = FrankPrices._refillEnd(timeline, nowIndex, current.price, settings);
    const costEnd = FrankPrices._refillEnd(timeline, nowIndex,
      costBasis / settings.efficiency + settings.wearCost, settings);
    return { floor, until: Math.min(houseEnd, costEnd) };
  }

  /**
   * Every known quarter from the current one on, today and tomorrow. An hourly
   * slot is cut into four quarters at the same price, so a count of quarters
   * means the same thing whatever resolution the source delivers.
   */
  async quartersAhead(now = Date.now()) {
    const today = await this._rowsFor(now) || [];
    const tomorrow = await this._rowsFor(FrankPrices.nextDayStart(now), now) || [];
    return FrankPrices.toQuarters(today.concat(tomorrow)).filter((row) => row.till > now);
  }

  static toQuarters(rows) {
    const out = [];
    for (const row of rows) {
      for (let from = row.from; from < row.till; from += QUARTER_MS) {
        out.push({ ...row, from, till: Math.min(row.till, from + QUARTER_MS) });
      }
    }
    return out;
  }

  /**
   * The `count` cheapest known quarters from now until `until` (ms), as a set
   * of quarter start times. The running quarter takes part; of two quarters at
   * the same price the earlier one wins. Quarters without a price yet (tomorrow
   * before it is published) are left out rather than refused: fewer known
   * quarters than `count` simply makes every known one a winner.
   *
   * The answer is fixed per (count, until) the first time it is asked for, and
   * kept in the store so a restart does not change it. Ranking again from a
   * later "now" would keep re-filling the count as chosen quarters pass - a
   * charger told "the 12 cheapest" would get 12 plus every quarter that slid
   * into the ranking behind them. It is only ranked again when prices for more
   * of the window come in (tomorrow published), the one thing that can make a
   * better choice possible.
   *
   * Returns { chosen: Set, known: number }; known is 0 when no quarter in the
   * window has a price.
   */
  async cheapestQuarters(count, until, now = Date.now()) {
    const quarters = await this.quartersAhead(now);
    const window = quarters.filter((row) => row.from < until);
    const covered = Math.min(until, window.length ? window[window.length - 1].till : 0);
    const rankings = this._loadRankings();
    let changed = false;
    for (const key of Object.keys(rankings)) {
      if (!(rankings[key].until > now)) { delete rankings[key]; changed = true; }
    }
    const key = `${count}|${until}`;
    let ranking = rankings[key];
    if (!ranking || covered > ranking.covered) {
      ranking = { until, covered, known: window.length, chosen: [...FrankPrices.rankCheapest(window, count)] };
      rankings[key] = ranking;
      changed = true;
    }
    if (changed) this._saveRankings(rankings);
    return { chosen: new Set(ranking.chosen), known: ranking.known };
  }

  _loadRankings() {
    if (!this._rankings) {
      let saved = null;
      try {
        saved = this._rankStore ? this._rankStore.read() : null;
      } catch (err) {
        saved = null;
      }
      this._rankings = saved && typeof saved === 'object' ? { ...saved } : {};
    }
    return this._rankings;
  }

  _saveRankings(rankings) {
    if (!this._rankStore) return;
    try {
      Promise.resolve(this._rankStore.write(rankings))
        .catch((err) => this.error('Could not store the quarter rankings: ' + err.message));
    } catch (err) {
      this.error('Could not store the quarter rankings: ' + err.message);
    }
  }

  /** The start times of the `count` cheapest slots, the earlier one first among equals. */
  static rankCheapest(slots, count) {
    const sorted = [...slots].sort((a, b) => a.price - b.price || a.from - b.from);
    return new Set(sorted.slice(0, Math.max(0, count)).map((row) => row.from));
  }

  /** Quarters needed to put `kwh` in at `kw`: 20 kWh at 6.9 kW is 12. */
  static quartersFor(kwh, kw) {
    if (!(kwh > 0) || !(kw > 0)) return 0;
    // The epsilon keeps 5 kWh at 5 kW at four quarters, not five.
    return Math.ceil(kwh / (kw * 0.25) - 1e-9);
  }

  /** The start of the quarter `ms` falls in. */
  static quarterStart(ms) {
    return Math.floor(ms / QUARTER_MS) * QUARTER_MS;
  }

  /**
   * The next moment the clock in `timeZone` reads `hhmm` ("07:00"), strictly
   * after the start of the current quarter: a time earlier than now - or now
   * itself - is tomorrow.
   */
  static nextClockTime(now, hhmm, timeZone = MARKET_TIME_ZONE) {
    const match = /^([0-9]{1,2}):([0-9]{2})$/.exec(String(hhmm || '').trim());
    if (!match) throw new Error(`Invalid time: ${hhmm}`);
    const [hour, minute] = [Number(match[1]), Number(match[2])];
    if (hour > 23 || minute > 59) throw new Error(`Invalid time: ${hhmm}`);
    const clock = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    const parts = (ms) => {
      const out = {};
      for (const { type, value } of clock.formatToParts(new Date(ms))) out[type] = Number(value);
      return out;
    };
    const offset = (ms) => {
      const p = parts(ms);
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
    };
    const today = parts(now);
    for (let day = 0; day <= 2; day++) {
      const wall = Date.UTC(today.year, today.month - 1, today.day + day, hour, minute);
      // Twice, so a guess on the wrong side of a clock change settles.
      let at = wall - offset(wall);
      at = wall - offset(at);
      if (at > FrankPrices.quarterStart(now)) return at;
    }
    throw new Error(`Invalid time: ${hhmm}`);
  }

  /** "HH:MM" on the clock of `timeZone`. */
  static clockText(ms, timeZone = MARKET_TIME_ZONE) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(ms));
  }

  /** A moment safely inside the market day after the one `now` falls in. */
  static nextDayStart(now) {
    // Noon is far from the 02:00/03:00 clock change, so +24 h from it always
    // lands in the next day, whether that day has 23, 24 or 25 hours.
    const [y, m, d] = FrankPrices.localDate(new Date(now)).split('-').map(Number);
    const guess = Date.UTC(y, m - 1, d, 12);
    const noon = guess - FrankPrices._zoneOffsetMs(guess);
    return noon + 24 * 3600 * 1000;
  }

  /**
   * YYYY-MM-DD of the market day `date` falls in. Explicitly in Amsterdam
   * time: Homey runs apps in UTC, so the process's own timezone put 00:00-02:00
   * (CEST) in the previous day - the first eight quarters of every day were
   * dropped, and for those two hours no price was "now" at all.
   */
  static localDate(date) {
    const parts = FrankPrices._zoneParts(date.getTime());
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  /** The hour (0-23) on the market clock. */
  static localHour(ms) {
    return Number(FrankPrices._zoneParts(ms).hour);
  }

  static _zoneParts(ms) {
    const out = {};
    for (const { type, value } of MARKET_CLOCK.formatToParts(new Date(ms))) out[type] = value;
    return out;
  }

  /** How far the market clock runs ahead of UTC at `ms` (1 or 2 hours). */
  static _zoneOffsetMs(ms) {
    const p = FrankPrices._zoneParts(ms);
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return asUtc - Math.floor(ms / 1000) * 1000;
  }

}

module.exports = FrankPrices;
module.exports.DEFAULTS = DEFAULTS;
module.exports.NL_NET_METERING_END = NL_NET_METERING_END;
