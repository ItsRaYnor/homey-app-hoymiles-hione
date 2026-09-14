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

  constructor({ log, error, endpoint } = {}) {
    this.log = log || (() => {});
    this.error = error || (() => {});
    this._endpoint = endpoint || ENDPOINT;

    this._rows = null;
    this._rowsDate = null;    // local date the cached rows belong to
    this._lastAttempt = 0;
    this._lastError = null;
  }

  /**
   * The day plan, or null when no prices could be obtained at all.
   * Never throws: a price outage must not take the battery poll down with it.
   */
  async getPlan(options = {}, now = Date.now()) {
    const rows = await this._rowsFor(now);
    if (!rows || !rows.length) return null;

    const settings = { ...DEFAULTS, ...options };
    const current = rows.find((row) => now >= row.from && now < row.till);
    const ahead = rows.filter((row) => row.till > now);
    if (!current || !ahead.length) return null;

    const all = rows.map((row) => row.price);
    const dayLow = Math.min(...all);
    const dayHigh = Math.max(...all);
    const lowAhead = Math.min(...ahead.map((row) => row.price));
    const highAhead = Math.max(...ahead.map((row) => row.price));

    // The day low is what the battery is (or will be) filled at, so it is the
    // reference for every sell decision — not the lowest price still to come,
    // which climbs as the day passes and would block the evening peak.
    const breakEven = dayLow / settings.efficiency + settings.wearCost;
    const dischargeFloor = breakEven + settings.minMargin;

    const spreadPays = dayHigh >= dischargeFloor;
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

    let action = 'hold';
    if (!spreadPays) action = 'flat';
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
  async getCurve(options = {}, now = Date.now()) {
    const rows = await this._rowsFor(now);
    if (!rows || !rows.length) return null;

    const plan = await this.getPlan(options, now);
    const settings = { ...DEFAULTS, ...options };
    const all = rows.map((row) => row.price);
    const dayLow = Math.min(...all);
    const dayHigh = Math.max(...all);
    const breakEven = dayLow / settings.efficiency + settings.wearCost;
    const dischargeFloor = breakEven + settings.minMargin;
    const spreadPays = dayHigh >= dischargeFloor;

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
      hours,
      plan,
      dayLow,
      dayHigh,
      marketHigh: Math.max(...rows.map((row) => row.market)),
      breakEven,
      dischargeFloor,
      spreadPays,
      hoursCovered: covered ? covered.length : null,
    };
  }
  /** Cached rows for the local day `now` falls in, fetching when needed. */
  async _rowsFor(now) {
    const date = FrankPrices.localDate(new Date(now));
    if (this._rows && this._rowsDate === date) return this._rows;
    if (now - this._lastAttempt < RETRY_INTERVAL_MS) return null;

    this._lastAttempt = now;
    try {
      const rows = await this._fetch(date);
      this._rows = rows;
      this._rowsDate = date;
      this._lastError = null;
      this.log(`[Prices] ${rows.length} prices for ${date}`);
      return this._rows;
    } catch (err) {
      this._lastError = err.message;
      this.error('Frank prices failed: ' + err.message);
      return null;
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
  /** YYYY-MM-DD in the Homey's own timezone, which is the day Frank bills on. */
  static localDate(date) {
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 10);
  }

}

module.exports = FrankPrices;
module.exports.DEFAULTS = DEFAULTS;
