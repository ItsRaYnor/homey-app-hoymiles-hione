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
 */

const ENDPOINT = 'https://frank-graphql-prod.graphcdn.app/';
const FALLBACK_ENDPOINT = 'https://www.dynamisch-tarief.nl/api/stroom/kwartierprijzen?uren=36';
const FALLBACK_NAME = 'dynamisch-tarief.nl';
const REQUEST_TIMEOUT_MS = 15000;

// Tomorrow is published around 13:00. Before that neither source has it, so
// asking the fallback every five minutes all morning would only be load on a
// hobby project; from this hour on a missing tomorrow means Frank is the problem.
const FALLBACK_TOMORROW_FROM_HOUR = 14;

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
  sellKw: 5,          // what the battery delivers while selling; 0 = never plan to sell
};

// A slot this short or shorter is a quarter (or half) hour. One of them that
// falls just outside a buy, sell or peak run is bridged rather than obeyed: the
// battery would otherwise switch mode for fifteen minutes and back, which costs
// a register write each way and gains a fraction of a cent.
const BRIDGE_MAX_SLOT_MS = 30 * 60 * 1000;

class FrankPrices {

  /**
   * @param {object} [options]
   * @param {{read: function(): object, write: function(object): *}} [options.store]
   *   Where fetched days survive a restart. Prices never change once published,
   *   so a restart during an internet outage can carry on with the day it
   *   already had instead of dropping every price decision until the line is
   *   back. Holds today and tomorrow only - a few kB.
   */
  constructor({ log, error, endpoint, fallbackEndpoint, store } = {}) {
    this.log = log || (() => {});
    this.error = error || (() => {});
    this._endpoint = endpoint || ENDPOINT;
    // null switches the fallback off (tests); undefined means the default.
    this._fallbackEndpoint = fallbackEndpoint === undefined ? FALLBACK_ENDPOINT : fallbackEndpoint;
    this._store = store || null;

    // One entry per local date: { rows, lastAttempt, source }. Only today and
    // tomorrow are ever asked for; past dates are dropped as the days roll over.
    this._cache = new Map();
    // One fallback answer covers today and tomorrow; kept for one retry interval
    // so both days are served by a single request.
    this._fallbackResponse = null;
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
    const dischargeNow = current.price >= dischargeFloor;
    const marketHighAhead = Math.max(...ahead.map((row) => row.market));

    // A battery that cannot cover the whole expensive stretch should spend what
    // it has on the dearest slots of it, not on the first one that happens to
    // clear the floor. With the energy on board and what the house is drawing,
    // the slots it can still cover are countable — so rank them and only call
    // this one a peak if it makes that list.
    const covered = FrankPrices._coveredSlots(ahead, settings);
    const flags = FrankPrices._slotFlags(rows, settings, {
      dayLow, spreadPays, dischargeFloor, covered,
    });
    const index = rows.indexOf(current);
    const buyNow = flags.buy[index];
    const sellNow = flags.sell[index];
    const peakNow = flags.peak[index];

    // How full is full enough? Charging to a fixed 95% buys whatever the battery
    // happens to have room for, not what the day will ask of it. Every slot still
    // ahead that clears the floor wants the house's draw for its length; every
    // slot where exporting clears it too wants what the battery delivers while
    // selling. Summed, that is a number of kWh, and that is a target. On a flat
    // winter day nothing clears the floor and the target falls to the floor
    // itself — which is the correct answer: do not buy at all. Solar still to
    // come is deliberately NOT subtracted; without a calibrated forecast that
    // would be a guess, and a wrong guess here is worse than the blunt
    // instrument it replaces.
    let chargeTarget = null;
    let energyNeededKwh = null;
    if (Number.isFinite(settings.loadKw) && settings.loadKw > 0
        && Number.isFinite(settings.capacityKwh) && settings.capacityKwh > 0) {
      const sellKw = Number.isFinite(settings.sellKw) ? settings.sellKw : 0;
      energyNeededKwh = ahead.reduce((sum, row) => {
        if (row.price < dischargeFloor) return sum;
        const selling = sellKw > 0 && row.price - settings.feedInPenalty >= dischargeFloor;
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
      hoursCovered: covered ? FrankPrices._sumHours(covered) : null,
      slotMinutes: Math.round(FrankPrices.slotHours(current) * 60),
      chargeTarget,
      energyNeededKwh,
      action,
      source: this._sourceFor(now),
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
    const covered = FrankPrices._coveredSlots(fromNow, settings);
    const flags = FrankPrices._slotFlags(rows, settings, {
      dayLow, spreadPays, dischargeFloor, covered,
    });

    // Still called "hours" because the settings page reads it by that name;
    // since Frank's quarter-hour prices each entry is fifteen minutes.
    const hours = rows.map((row, index) => ({
      from: row.from,
      till: row.till,
      price: row.price,
      market: row.market,
      buy: flags.buy[index],
      discharge: row.price >= dischargeFloor,
      peak: flags.peak[index],
      sell: flags.sell[index],
      now: now >= row.from && now < row.till,
    }));

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
      hoursCovered: covered ? FrankPrices._sumHours(covered) : null,
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
      if (key < today) this._cache.delete(key);
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
      if (saved && !savedHourly) {
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
    if (now - entry.lastAttempt < RETRY_INTERVAL_MS) return current;

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
      entry.source = 'frank';
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
    if (isToday) this.error('Frank prices failed: ' + frankError.message);
    if (!isToday && new Date(now).getHours() < FALLBACK_TOMORROW_FROM_HOUR) return current;

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
    const rows = saved && saved[date];
    if (!Array.isArray(rows) || !rows.length) return null;
    const valid = rows.every((row) => row
      && Number.isFinite(row.from) && Number.isFinite(row.till)
      && Number.isFinite(row.price) && Number.isFinite(row.market)
      && FrankPrices.localDate(new Date(row.from)) === date);
    return valid ? rows : null;
  }

  /** 'fallback' when the stored day came from the fallback, else 'frank'. */
  _savedSource(date) {
    if (!this._store) return 'frank';
    try {
      const saved = this._store.read();
      return saved && saved.sources && saved.sources[date] === 'fallback' ? 'fallback' : 'frank';
    } catch (err) {
      return 'frank';
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
    try {
      Promise.resolve(this._store.write(out))
        .catch((err) => this.error('Could not store prices: ' + err.message));
    } catch (err) {
      this.error('Could not store prices: ' + err.message);
    }
  }

  async _fetch(date) {
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
   * The slots the battery can still cover, dearest first. Null when the state
   * of charge or the house load is unknown, which means "do not rank" rather
   * than "cover nothing" — an unknown must never stop the battery working.
   *
   * Counted in energy, not in slots: a quarter hour asks a quarter of what an
   * hour does, so the dearest slots are taken until the charge on board is
   * spent. The slot that exhausts it still counts, as the whole hour did.
   */
  static _coveredSlots(ahead, settings) {
    const { usableKwh, loadKw } = settings;
    if (!Number.isFinite(usableKwh) || !Number.isFinite(loadKw)) return null;
    if (loadKw <= 0.1) return null;
    if (usableKwh <= 0) return [];

    const covered = [];
    let energy = 0;
    for (const row of [...ahead].sort((a, b) => b.price - a.price)) {
      if (covered.length && energy >= usableKwh) break;
      covered.push(row);
      energy += loadKw * FrankPrices.slotHours(row);
    }
    return covered;
  }

  /**
   * Buy, sell and peak verdicts for every slot of one day, in order.
   *
   * Each verdict depends only on the slot itself and what comes after it that
   * day, which is what lets the settings chart and the live plan share it. With
   * quarter-hour prices a run of buy or sell slots is often broken by a single
   * quarter just outside the band; flipping the battery for that one quarter
   * costs two register writes to gain a fraction of a cent, so such a gap is
   * bridged - but never into a trade that loses money: a bridged buy must stay
   * within twice the band of the day low, a bridged sale must still clear the
   * floor after the export penalty, and a bridged peak must still clear it too.
   */
  static _slotFlags(rows, settings, { dayLow, spreadPays, dischargeFloor, covered }) {
    const n = rows.length;
    const minAhead = new Array(n);
    const maxAhead = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      const price = rows[i].price;
      minAhead[i] = i === n - 1 ? price : Math.min(price, minAhead[i + 1]);
      maxAhead[i] = i === n - 1 ? price : Math.max(price, maxAhead[i + 1]);
    }
    const coveredFrom = covered ? new Set(covered.map((row) => row.from)) : null;
    const sellClears = (row) => row.price - settings.feedInPenalty >= dischargeFloor;

    // Buying asks two things: near the cheapest slot of the day, and not
    // jumping the gun on a cheaper slot still ahead. Exporting has to clear the
    // same floor as self-consumption plus whatever it earns less; the timing test
    // stays on the all-in price, since tax and fees are the same in every slot.
    const buy = rows.map((row, i) => spreadPays
      && row.price <= dayLow + settings.buyBand
      && row.price <= minAhead[i] + settings.buyBand);
    const sell = rows.map((row, i) => sellClears(row)
      && row.price >= maxAhead[i] - settings.sellBand);
    const peak = rows.map((row) => row.price >= dischargeFloor
      && (!coveredFrom || coveredFrom.has(row.from)));

    const bridge = (raw, allowed) => raw.map((value, i) => value || (
      i > 0 && i < n - 1 && raw[i - 1] && raw[i + 1]
      && rows[i].till - rows[i].from <= BRIDGE_MAX_SLOT_MS
      && allowed(rows[i])));

    return {
      buy: bridge(buy, (row) => spreadPays && row.price <= dayLow + 2 * settings.buyBand),
      sell: bridge(sell, sellClears),
      peak: bridge(peak, (row) => row.price >= dischargeFloor),
    };
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
