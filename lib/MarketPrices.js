'use strict';

/**
 * Day-ahead market prices for bidding zones outside the Netherlands.
 *
 * The Netherlands keeps Frank Energie (see FrankPrices): it publishes the
 * all-in price a household actually pays, tax and markup included. Nothing
 * like that exists across borders, so every other zone gets the bare
 * day-ahead price from Energy-Charts (Fraunhofer ISE) - keyless, in quarter
 * hours, one request per day - and the user supplies what their own supplier
 * and tax office put on top:
 *
 *   price = (market + surcharge) * (1 + vat)
 *
 * The surcharge is a flat amount per kWh, so it shifts every slot alike and
 * the buy and sell decisions barely notice it; it matters for the price tile
 * and for what an exported kWh fails to earn back (see the device).
 *
 * Data: Bundesnetzagentur | SMARD.de and ENTSO-E via energy-charts.info,
 * CC BY 4.0.
 */

const ENDPOINT = 'https://api.energy-charts.info/price';

// The zone the Dutch source serves; everything else goes to Energy-Charts.
const FRANK_ZONE = 'NL';

// Bidding zones offered in the device settings: Germany and the zones around
// it, which Energy-Charts republishes from SMARD under CC BY 4.0. The other
// Nordic and Italian zones come with a "private and internal use only" notice
// and are left out on purpose. Countries with one zone can be picked from the
// time zone; Denmark, Norway, Sweden and Italy have several, so those are
// only ever chosen by hand.
const ZONES = ['NL', 'DE-LU', 'AT', 'BE', 'FR', 'CH', 'PL', 'CZ', 'HU', 'SI',
  'DK1', 'DK2', 'NO2', 'SE4', 'IT-North'];

const TIMEZONE_ZONES = {
  'Europe/Amsterdam': 'NL',
  'Europe/Berlin': 'DE-LU',
  'Europe/Busingen': 'DE-LU',
  'Europe/Luxembourg': 'DE-LU',
  'Europe/Vienna': 'AT',
  'Europe/Brussels': 'BE',
  'Europe/Paris': 'FR',
  'Europe/Zurich': 'CH',
  'Europe/Warsaw': 'PL',
  'Europe/Prague': 'CZ',
  'Europe/Budapest': 'HU',
  'Europe/Ljubljana': 'SI',
};

/**
 * The zone a Homey in time zone `timezone` is in, or null when that cannot be
 * told (a country with several zones, or one this app has no prices for).
 * An unknown time zone - a Homey that will not say - counts as the
 * Netherlands, which is what every version before this one assumed.
 */
function zoneForTimezone(timezone) {
  if (!timezone) return FRANK_ZONE;
  return TIMEZONE_ZONES[timezone] || null;
}

/** The request for one market day (00:00-24:00 Central European Time). */
function urlFor(zone, date, endpoint = ENDPOINT) {
  return `${endpoint}?bzn=${encodeURIComponent(zone)}&start=${date}&end=${date}`;
}

/**
 * Energy-Charts' answer as price rows. Prices arrive in EUR/MWh on a list of
 * start times; a slot runs to the next start, and the last one is as long as
 * the one before it. Slots without a price (not published yet) are dropped.
 */
function parse(payload, { surcharge = 0, vat = 0 } = {}) {
  const starts = payload && payload.unix_seconds;
  const prices = payload && payload.price;
  if (!Array.isArray(starts) || !Array.isArray(prices) || !starts.length) {
    throw new Error('no prices returned');
  }
  const step = starts.length > 1 ? starts[1] - starts[0] : 3600;
  const rows = [];
  for (let i = 0; i < starts.length; i++) {
    const market = prices[i] / 1000;
    if (!Number.isFinite(starts[i]) || prices[i] === null || !Number.isFinite(market)) continue;
    const till = i + 1 < starts.length ? starts[i + 1] : starts[i] + step;
    rows.push({
      from: starts[i] * 1000,
      till: till * 1000,
      // price = what importing costs; market = what exporting earns.
      price: (market + surcharge) * (1 + vat),
      market,
    });
  }
  if (!rows.length) throw new Error('no prices returned');
  return rows.sort((a, b) => a.from - b.from);
}

module.exports = {
  ENDPOINT,
  FRANK_ZONE,
  ZONES,
  zoneForTimezone,
  urlFor,
  parse,
};
