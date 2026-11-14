'use strict';

/**
 * The price plan: which prices to fetch, the plan computed from them, the
 * tiles that show it and the Flow triggers that follow it.
 *
 * Part of HiOneDevice. The methods of this class are copied onto the
 * device's prototype at the end of device.js, so `this` is the device itself
 * and they can call, and be called by, everything else on it. This is one
 * class written in several files to keep each readable - nothing here is a
 * separate object at runtime.
 */

const FrankPrices = require('../../../lib/FrankPrices');
const MarketPrices = require('../../../lib/MarketPrices');

// The day plan only changes when the clock moves into the next price hour, and
// the prices themselves are fetched once a day. Recomputing every minute would
// be free but pointless; once a minute past the poll is close enough to catch
// the hour change without a burst of capability writes.
const PRICE_REFRESH_MS = 60_000; // 1 min

// Same idea for the charge target: a percent either way is not worth a write.
const TARGET_TOLERANCE_PCT = 2;

// The price moments a Flow can be started by, and the plan field behind each.
const PRICE_MOMENTS = { buy: 'buyNow', sell: 'sellNow', peak: 'peakNow' };

class PricePlan {

  /**
   * The day's price plan, straight from Frank Energie's public API.
   *
   * Recomputed on every call rather than cached: the prices themselves are
   * fetched once a day, but which of them is 'now' changes on the hour, and a
   * Flow condition must never answer for the previous hour.
   */
  async getPricePlan() {
    if (this.getSetting('price_enabled') === false || !this._prices) return null;
    return this._prices.getPlan(this._priceOptions());
  }

  /**
   * The bidding zone the prices are fetched for: the one chosen in the
   * settings, or on "automatic" the one Homey's time zone points at. Null when
   * that cannot be told - then there is no plan, and the tile asks for a zone.
   * A Dutch Homey always resolves to the Netherlands, so it keeps Frank
   * Energie without anybody having to set anything.
   */
  _resolvePriceZone(settings) {
    const choice = settings.price_zone || 'auto';
    if (choice !== 'auto') return choice;
    let timezone = null;
    try {
      timezone = this.homey.clock.getTimezone();
    } catch (err) {
      // No clock manager to ask: MarketPrices falls back to the Netherlands.
    }
    return MarketPrices.zoneForTimezone(timezone);
  }

  /**
   * (Re)build the price source from the settings. Called at start and when the
   * zone, surcharge or VAT changes; newSettings because getSettings() still
   * returns the old values while onSettings runs.
   */
  _createPrices(settingsOverride) {
    const settings = settingsOverride || this.getSettings();
    const number = (key) => (Number.isFinite(settings[key]) ? settings[key] : 0);
    this._priceZone = this._resolvePriceZone(settings);
    this._priceSurcharge = number('price_surcharge') / 100;
    this._priceVat = number('price_vat') / 100;
    this._pricePlan = null;
    this._lastPriceRefresh = 0;
    if (!this._priceZone) {
      this.log('[Prices] no bidding zone for this time zone - choose one in the device settings');
      this._prices = null;
      return;
    }
    this.log(`[Prices] zone ${this._priceZone}`);
    this._prices = new FrankPrices({
      log: (...args) => this.log(...args),
      error: (...args) => this.error(...args),
      zone: this._priceZone,
      surcharge: this._priceSurcharge,
      vat: this._priceVat,
      store: {
        read: () => this.getStoreValue('frank_prices'),
        write: (value) => this.setStoreValue('frank_prices', value),
      },
    });
  }

  /**
   * A whole day for the settings page: today including the hours still to
   * come, or tomorrow once Frank has published it.
   */
  async getPriceCurve(day = 'today') {
    if (this.getSetting('price_enabled') === false || !this._prices) return null;
    const curve = await this._prices.getCurve(this._priceOptions(), Date.now(), day);
    return curve && {
      ...curve,
      zone: this._priceZone,
      // The line on the price plan tile, for the dashboard widget.
      planText: curve.plan ? this._pricePlanText(curve.plan) : null,
    };
  }

  /** The bidding zone in use, or null when none could be told. */
  getPriceZone() {
    return this._priceZone || null;
  }

  /**
   * Aim the Force Charge target at what the coming expensive hours will ask for,
   * instead of at a fixed level. Buying past that costs a cycle for energy the
   * day has no use for, and fills the room the sun was going to use for free.
   */
  async chargeToPlan() {
    const plan = await this.getPricePlan();
    if (!plan || !Number.isFinite(plan.chargeTarget)) {
      throw new Error(this.homey.__('errors.no_target'));
    }

    const current = this.getCapabilityValue('hoymiles_reserve_soc_forcecharge');
    if (Number.isFinite(current) && Math.abs(current - plan.chargeTarget) <= TARGET_TOLERANCE_PCT) {
      this.log(`Charge target already ${current}% (plan says ${plan.chargeTarget}%) - no write`);
      return null;
    }

    await this._hybrid.setReserveSocForMode(5, plan.chargeTarget);
    this._refreshLocalSettings().catch(() => {});
    this._scheduleLivePollBurst();
    return plan.chargeTarget;
  }

  /** Settings are kept in ct/kWh and percent; the plan works in EUR/kWh. */
  _priceOptions() {
    const cents = (key, fallback) => {
      const value = this.getSetting(key);
      return Number.isFinite(value) ? value / 100 : fallback;
    };
    const roundTrip = this.getSetting('price_round_trip');
    const capacity = this.getSetting('price_capacity_kwh');
    // Dutch net metering hands the tax on an exported kWh back, so there the
    // penalty is only the fees. Nowhere else does: an exported kWh earns the
    // bare market price and never sees the surcharge it would have cost to
    // import. Leaving that out would sell at prices that lose money.
    const exportGap = this._priceZone && this._priceZone !== MarketPrices.FRANK_ZONE
      ? (this._priceSurcharge || 0) * (1 + (this._priceVat || 0))
      : 0;
    return {
      ...this._batteryState(Number.isFinite(capacity) ? capacity : FrankPrices.DEFAULTS.capacityKwh),
      wearCost:   cents('price_wear_cost',  FrankPrices.DEFAULTS.wearCost),
      minMargin:  cents('price_min_margin', FrankPrices.DEFAULTS.minMargin),
      buyBand:    cents('price_buy_band',   FrankPrices.DEFAULTS.buyBand),
      sellBand:   cents('price_sell_band',  FrankPrices.DEFAULTS.sellBand),
      feedInPenalty: cents('price_feed_in_penalty', FrankPrices.DEFAULTS.feedInPenalty) + exportGap,
      sellKw:     Number.isFinite(this.getSetting('price_sell_kw'))
        ? this.getSetting('price_sell_kw')
        : FrankPrices.DEFAULTS.sellKw,
      floorSoc:   Number.isFinite(this.getSetting('price_floor_soc'))
        ? this.getSetting('price_floor_soc')
        : FrankPrices.DEFAULTS.floorSoc,
      capacityKwh: Number.isFinite(this.getSetting('price_capacity_kwh'))
        ? this.getSetting('price_capacity_kwh')
        : FrankPrices.DEFAULTS.capacityKwh,
      efficiency: Number.isFinite(roundTrip) && roundTrip > 0
        ? roundTrip / 100
        : FrankPrices.DEFAULTS.efficiency,
    };
  }

  /**
   * What the battery has to spend and what the house is drawing. Both are
   * needed to work out how many of the coming expensive hours it can cover.
   * Either may be missing right after a restart; the plan then simply does not
   * rank, rather than assuming the battery is empty.
   */
  _batteryState(capacityKwh) {
    const soc = this.getCapabilityValue('measure_battery');
    const load = this.getCapabilityValue('hoymiles_load_power');
    const state = {};

    // Measured against the level the battery is ALLOWED to discharge to, never
    // against the reserve it happens to sit at. Using the live reserve makes the
    // answer depend on the very setting it is meant to drive: a reserve parked
    // above the charge reads as "nothing usable", so no hour is ever dear enough
    // to release it, so the reserve stays parked. Seen live, holding the battery
    // idle straight through the most expensive hour of the day.
    const configured = this.getSetting('price_floor_soc');
    const floor = Number.isFinite(configured) ? configured : 30;
    if (Number.isFinite(soc)) {
      state.usableKwh = Math.max(0, (soc - floor) / 100 * capacityKwh);
    }
    // The load reading is taken at the grid connection, so anything else on the
    // meter lands in it — here a set of batteries traded by the supplier on a
    // separate contract. Five kilowatts of somebody else's trade makes the house
    // look ravenous and shrinks the hours this battery thinks it can cover. A
    // configured figure overrides the measurement for exactly that reason.
    const assumed = this.getSetting('price_load_kw');
    if (Number.isFinite(assumed) && assumed > 0) state.loadKw = assumed;
    else if (Number.isFinite(load)) state.loadKw = load / 1000;
    return state;
  }

  async _refreshPricePlan() {
    if (this.getSetting('price_enabled') === false) return;
    const now = Date.now();
    if (now - this._lastPriceRefresh < PRICE_REFRESH_MS) return;
    this._lastPriceRefresh = now;

    const plan = await this.getPricePlan().catch((err) => {
      this.error('Price plan failed: ' + err.message);
      return null;
    });
    this._pricePlan = plan;

    if (!plan) {
      await this._setCapabilitySafe('hoymiles_price_plan',
        this.homey.__(this._prices ? 'price.unknown' : 'price.no_zone'));
      // Empty the price tiles rather than leave the last price standing: a
      // frozen number looks like a real one (it did, 00:00-02:00 every night
      // before 1.1.9), an empty tile and a gap in Insights do not.
      for (const capability of [
        'hoymiles_price_now', 'hoymiles_price_market_now', 'hoymiles_price_discharge_floor',
        'hoymiles_price_buy_moment', 'hoymiles_price_sell_moment',
      ]) {
        if (!this.hasCapability(capability) || this.getCapabilityValue(capability) === null) continue;
        await this.setCapabilityValue(capability, null)
          .catch((err) => this.error(`Could not clear ${capability}: ${err.message}`));
      }
      return;
    }

    const ct = (value) => Math.round(value * 1000) / 10;
    await this._setCapabilitySafe('hoymiles_price_now',        ct(plan.priceNow));
    await this._setCapabilitySafe('hoymiles_price_market_now', ct(plan.marketNow));
    await this._setCapabilitySafe('hoymiles_price_charge_target', plan.chargeTarget);
    await this._setCapabilitySafe('hoymiles_price_low_today',  ct(plan.dayLow));
    await this._setCapabilitySafe('hoymiles_price_high_today', ct(plan.dayHigh));
    await this._setCapabilitySafe('hoymiles_price_plan',       this._pricePlanText(plan));
    // For Insights: what the plan wanted, and the floor it judged against.
    await this._setCapabilitySafe('hoymiles_price_discharge_floor', ct(plan.dischargeFloor));
    await this._setCapabilitySafe('hoymiles_price_buy_moment',  Boolean(plan.buyNow));
    await this._setCapabilitySafe('hoymiles_price_sell_moment', Boolean(plan.sellNow));
    await this._firePriceMomentTriggers(plan);
  }

  /**
   * Start a Flow at the minute a buy, sell or peak moment begins or ends, so
   * nobody has to ask "is it a sell moment?" every five minutes.
   *
   * The last known state lives in the device store, not in memory: an app
   * restart in the middle of a sell moment must not announce it a second time,
   * and a moment that began while the app was down is still announced by the
   * first plan after it. A missing plan changes nothing - "no prices" is not
   * "the moment ended", and a Flow that stops selling on a guess is the kind
   * of mistake the conditions already refuse to make.
   */
  async _firePriceMomentTriggers(plan) {
    const stored = this.getStoreValue('price_moments');
    const previous = stored && typeof stored === 'object' ? stored : null;
    const current = {};
    for (const [moment, field] of Object.entries(PRICE_MOMENTS)) current[moment] = Boolean(plan[field]);

    const changed = Object.keys(current).filter((moment) => !previous || previous[moment] !== current[moment]);
    if (!changed.length) return;
    await this.setStoreValue('price_moments', current)
      .catch((err) => this.error('Could not store price moments: ' + err.message));
    // Nothing to compare with on the very first plan of a new device: saying
    // "ended" for three moments that never began would only start Flows.
    if (!previous) return;

    const tokens = { price: Math.round(plan.priceNow * 1000) / 10 };
    for (const moment of changed) {
      const card = current[moment] ? 'price_moment_started' : 'price_moment_ended';
      this.log(`Price moment: ${moment} ${current[moment] ? 'started' : 'ended'} at ${tokens.price} ct`);
      this.homey.flow.getDeviceTriggerCard(card)
        .trigger(this, tokens, { moment })
        .catch((err) => this.error('Trigger failed: ' + err.message));
    }
  }

  /** One line for the tile: what to do, and the price that decides it. */
  _pricePlanText(plan) {
    // Buying is no longer tied to the day low (it can be the night before a
    // dear morning), so "buy" shows what is being paid now and "hold" the
    // price of the next buy moment, when there is one.
    const buyCeiling = plan.dayLow + (this._priceOptions().buyBand || 0);
    let price = plan.dischargeFloor;
    if (plan.action === 'buy') price = plan.priceNow;
    else if (plan.action === 'hold') price = Number.isFinite(plan.nextBuyPrice) ? plan.nextBuyPrice : buyCeiling;
    // Substituted here rather than handed to __(): Homey's i18n leaves the
    // {{price}} placeholder standing, which put it on the tile verbatim.
    return String(this.homey.__('price.' + plan.action))
      .replace('{{price}}', this._formatCents(price));
  }

  _formatCents(euroPerKwh) {
    const text = (euroPerKwh * 100).toFixed(1);
    let language = 'en';
    try {
      language = this.homey.i18n.getLanguage() || 'en';
    } catch (err) {
      // Older firmware without i18n.getLanguage: the dot is a safe default.
    }
    return ['nl', 'de'].includes(language) ? text.replace('.', ',') : text;
  }

}

module.exports = PricePlan;
