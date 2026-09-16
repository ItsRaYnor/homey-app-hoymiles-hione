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
 * set it to what your own invoice shows, and revisit it when net metering ends,
 * because then the gap becomes the whole tax and grows with the price.
 *
 * Everything here turns that one inequality into a handful of yes/no answers a
 * Flow can act on, so no Flow has to carry a hard-coded price threshold. Fixed
 * thresholds break on the days that matter: on a day where every hour is above
 * 23 ct the battery would never buy, and on a flat day it would trade all day
 * for nothing. The spread moves, so the thresholds have to move with it.
 *
 * Frank's public GraphQL endpoint needs no key. The all-in price is the sum of
 * the four components below, which matches what the Frank app shows to the cent.
 */

const ENDPOINT = 'https://frank-graphql-prod.graphcdn.app/';
const REQUEST_TIMEOUT_MS = 15000;

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
  feedInPenalty: 0.0533, // EUR/kWh that exporting earns less than self-consuming
  floorSoc: 30,       // % the battery is allowed to discharge to
};

class FrankPrices {

  /**
   * @param {object} [options]
   * @param {{read: function(): object, write: function(object): *}} [options.store]
   *   Where fetched days survive a restart. Prices never change once published,
   *   so a restart during an internet outage can carry on with the day it
   *   already had instead of dropping every price decision until the line is
   *   back. Holds today and tomorrow only - a few kB.
   */
  constructor({ log, error, endpoint, store } = {}) {
    this.log = log || (() => {});
    this.error = error || (() => {});
    this._endpoint = endpoint || ENDPOINT;
    this._store = store || null;

    // One entry per local date: { rows, lastAttempt }. Only today and tomorrow
    // are ever asked for; past dates are dropped as the days roll over.
    this._cache = new Map();
  }

  /**
   * The day plan, or null when no prices could be obtained at all.
   * Never throws: a price outage must not take the battery poll down with it.
   */
  async getPlan(options = {}, now = Date.now()) {
    const rows = await this._rowsFor(now);
    if (!rows || !rows.length) return null;
    // Tomorrow is published in the early afternoon and simply absent before.
    const tomorrow = await this._rowsFor(FrankPrices.nextDayStart(now), now) || [];

    const settings = { ...DEFAULTS, ...options };
    const current = rows.find((row) => now >= row.from && now < row.till);
    const ahead = rows.filter((row) => row.till > now);
    if (!current || !ahead.length) return null;

    const all = rows.map((row) => row.price);
    const dayLow = Math.min(...all);
    const dayHigh = Math.max(...all);
    const lowAhead = Math.min(...ahead.map((row) => row.price));
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
    const dischargeFloor = breakEven + settings.minMargin;

    // Buying is judged on today alone: what is bought now is paid at today's
    // prices, and a cheap tomorrow says nothing about whether today's spread
    // covers that.
    const buyFloor = dayLow / settings.efficiency + settings.wearCost + settings.minMargin;
    const spreadPays = dayHigh >= buyFloor;
    // Buying asks two things: near the cheapest hour of the day, and not
    // jumping the gun on a cheaper hour still ahead.
    const buyNow = spreadPays
      && current.price <= dayLow + settings.buyBand
      && current.price <= lowAhead + settings.buyBand;
    const dischargeNow = current.price >= dischargeFloor;

    // Exporting has to clear the same floor as self-consumption plus whatever it
    // earns less. The timing test stays on the all-in price: the tax and fees are
    // the same in every hour, so ranking the hours by all-in ranks them by market
    // too, and the all-in series is the one with no rounding of its own.
    const marketHighAhead = Math.max(...ahead.map((row) => row.market));
    const sellNow = current.price - settings.feedInPenalty >= dischargeFloor
      && current.price >= highAhead - settings.sellBand;

    // A battery that cannot cover the whole expensive stretch should spend what
    // it has on the dearest hours of it, not on the first hour that happens to
    // clear the floor. With the energy on board and what the house is drawing,
    // the hours it can still cover are countable — so rank them and only call
    // this one a peak hour if it makes that list.
    const covered = FrankPrices._coveredHours(ahead, settings);
    const peakNow = dischargeNow
      && (!covered || covered.some((row) => row.from === current.from));

    // How full is full enough? Charging to a fixed 95% buys whatever the battery
    // happens to have room for, not what the day will ask of it. The hours still
    // ahead that clear the floor are the ones worth covering; at the house's own
    // draw that is a number of kWh, and that is a target. On a flat winter day
    // nothing clears the floor and the target falls to the floor itself — which is
    // the correct answer: do not buy at all. Solar still to come is deliberately
    // NOT subtracted; without a calibrated forecast that would be a guess, and a
    // wrong guess here is worse than the blunt instrument it replaces.
    let chargeTarget = null;
    let energyNeededKwh = null;
    if (Number.isFinite(settings.loadKw) && settings.loadKw > 0
        && Number.isFinite(settings.capacityKwh) && settings.capacityKwh > 0) {
      const worthCovering = ahead.filter((row) => row.price >= dischargeFloor);
      energyNeededKwh = worthCovering.length * settings.loadKw;
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

    // A flat today no longer means nothing to do: against a cheap tomorrow the
    // evening can still be worth discharging into.
    let action = 'hold';
    if (!spreadPays && !dischargeNow) action = 'flat';
    else if (buyNow) action = 'buy';
    else if (sellNow) action = 'sell';
    else if (peakNow) action = 'discharge';
    else if (dischargeNow) action = 'save';

    return {
      priceNow: current.price,
      marketNow: current.market,
      from: current.from,
      till: current.till,
      dayLow,
      dayHigh,
      tomorrowLow,
      referenceLow,
      lowAhead,
      highAhead,
      marketHighAhead,
      breakEven,
      dischargeFloor,
      spreadPays,
      buyNow,
      dischargeNow,
      peakNow,
      sellNow,
      cheaperRefillAhead,
      hoursCovered: covered ? covered.length : null,
      chargeTarget,
      energyNeededKwh,
      action,
    };
  }

  /**
   * The whole day, hour by hour, with the verdict the plan would give at each
   * hour. Insights can only ever draw what a value was at the moment it was
   * recorded, so it cannot show the hours still to come; this can, because the
   * day is already in hand after one fetch.
   */
  async getCurve(options = {}, now = Date.now(), day = 'today') {
    const isTomorrow = day === 'tomorrow';
    const rows = isTomorrow
      ? await this._rowsFor(FrankPrices.nextDayStart(now), now)
      : await this._rowsFor(now);
    if (!rows || !rows.length) return null;

    // Tomorrow is drawn as it will stand at midnight: no hour is current, no
    // ranking (the charge it starts with is not known yet) and no live plan.
    const plan = isTomorrow ? null : await this.getPlan(options, now);
    const settings = { ...DEFAULTS, ...options };
    if (isTomorrow) settings.usableKwh = undefined;
    const all = rows.map((row) => row.price);
    const dayLow = Math.min(...all);
    const dayHigh = Math.max(...all);
    // Today draws the same floor the plan acts on. For tomorrow the day after
    // is not known, so its own low is the only reference there is.
    const referenceLow = plan ? plan.referenceLow : dayLow;
    const breakEven = referenceLow / settings.efficiency + settings.wearCost;
    const dischargeFloor = breakEven + settings.minMargin;
    const spreadPays = dayHigh >= dayLow / settings.efficiency + settings.wearCost + settings.minMargin;

    // What the battery can still cover is a property of right now, so the ranking
    // is taken once from the current hour onward and the whole curve is drawn
    // against it. Hours already past keep their price but win no colour.
    const fromNow = rows.filter((row) => row.till > now);
    const covered = FrankPrices._coveredHours(fromNow, settings);
    const coveredFrom = new Set((covered || []).map((row) => row.from));

    const hours = rows.map((row, index) => {
      const ahead = rows.slice(index);
      const lowAhead = Math.min(...ahead.map((other) => other.price));
      const marketHighAhead = Math.max(...ahead.map((other) => other.market));
      const buy = spreadPays
        && row.price <= dayLow + settings.buyBand
        && row.price <= lowAhead + settings.buyBand;
      const discharge = row.price >= dischargeFloor;
      return {
        from: row.from,
        till: row.till,
        price: row.price,
        market: row.market,
        buy,
        discharge,
        peak: discharge && (!covered || coveredFrom.has(row.from)),
        sell: row.price - settings.feedInPenalty >= dischargeFloor
          && row.price >= Math.max(...ahead.map((other) => other.price)) - settings.sellBand,
        now: now >= row.from && now < row.till,
      };
    });

    return {
      day: isTomorrow ? 'tomorrow' : 'today',
      date: FrankPrices.localDate(new Date(rows[0].from)),
      hours,
      plan,
      dayLow,
      dayHigh,
      referenceLow,
      marketHigh: Math.max(...rows.map((row) => row.market)),
      breakEven,
      dischargeFloor,
      spreadPays,
      hoursCovered: covered ? covered.length : null,
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
      if (key < today) this._cache.delete(key);
    }

    let entry = this._cache.get(date);
    if (!entry) {
      entry = { rows: null, lastAttempt: 0 };
      this._cache.set(date, entry);
    }
    if (entry.rows) return entry.rows;

    // A day fetched before the last restart is as good as a fresh one.
    const saved = this._savedRows(date);
    if (saved) {
      entry.rows = saved;
      this.log(`[Prices] ${saved.length} prices for ${date} from storage`);
      return saved;
    }

    if (now - entry.lastAttempt < RETRY_INTERVAL_MS) return null;

    entry.lastAttempt = now;
    try {
      // Asked for a day that is not published yet, the endpoint may answer
      // with nothing or with neighbouring hours; only the day itself counts.
      const rows = (await this._fetch(date))
        .filter((row) => FrankPrices.localDate(new Date(row.from)) === date);
      if (!rows.length) throw new Error('no prices returned');
      entry.rows = rows;
      this.log(`[Prices] ${rows.length} prices for ${date}`);
      this._saveRows(today);
      return rows;
    } catch (err) {
      // Tomorrow is not out until the early afternoon. That is the normal
      // state of affairs, not something to log every five minutes.
      if (date === today) this.error('Frank prices failed: ' + err.message);
      return null;
    }
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
    const rows = saved && saved[date];
    if (!Array.isArray(rows) || !rows.length) return null;
    const valid = rows.every((row) => row
      && Number.isFinite(row.from) && Number.isFinite(row.till)
      && Number.isFinite(row.price) && Number.isFinite(row.market)
      && FrankPrices.localDate(new Date(row.from)) === date);
    return valid ? rows : null;
  }

  /** Persist the cached days from `today` on; older ones are left behind. */
  _saveRows(today) {
    if (!this._store) return;
    const out = {};
    for (const [date, entry] of this._cache) {
      if (date >= today && entry.rows) out[date] = entry.rows;
    }
    try {
      Promise.resolve(this._store.write(out))
        .catch((err) => this.error('Could not store prices: ' + err.message));
    } catch (err) {
      this.error('Could not store prices: ' + err.message);
    }
  }

  async _fetch(date) {
    const next = FrankPrices.localDate(new Date(new Date(`${date}T12:00:00`).getTime() + 24 * 3600 * 1000));
    const query = `{ marketPricesElectricity(startDate: "${date}", endDate: "${next}") {`
      + ' from till marketPrice marketPriceTax sourcingMarkupPrice energyTaxPrice } }';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let payload;
    try {
      const response = await fetch(this._endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      payload = await response.json();
    } finally {
      clearTimeout(timer);
    }

    if (payload && payload.errors && payload.errors.length) {
      throw new Error(payload.errors[0].message || 'GraphQL error');
    }
    const rows = payload && payload.data && payload.data.marketPricesElectricity;
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

  /**
   * The hours the battery can still cover, dearest first. Null when the state
   * of charge or the house load is unknown, which means "do not rank" rather
   * than "cover nothing" — an unknown must never stop the battery working.
   */
  static _coveredHours(ahead, settings) {
    const { usableKwh, loadKw } = settings;
    if (!Number.isFinite(usableKwh) || !Number.isFinite(loadKw)) return null;
    if (loadKw <= 0.1) return null;
    if (usableKwh <= 0) return [];

    const hours = Math.max(1, Math.ceil(usableKwh / loadKw));
    return [...ahead].sort((a, b) => b.price - a.price).slice(0, hours);
  }
  /** A moment safely inside the local day after the one `now` falls in. */
  static nextDayStart(now) {
    const noon = new Date(`${FrankPrices.localDate(new Date(now))}T12:00:00`);
    return noon.getTime() + 24 * 3600 * 1000;
  }

  /** YYYY-MM-DD in the Homey's own timezone, which is the day Frank bills on. */
  static localDate(date) {
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 10);
  }

}

module.exports = FrankPrices;
module.exports.DEFAULTS = DEFAULTS;
