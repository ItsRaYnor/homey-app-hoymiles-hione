'use strict';

/**
 * Data for the price plan widget. Comes from the device, like the price chart
 * on the settings page, so the widget shows the verdicts the Flow cards give
 * and not a second opinion with other settings.
 */

/** The device the prices are planned for: the one with a stick, else any. */
function mainDevice(homey) {
  let devices = [];
  try {
    devices = homey.drivers.getDriver('hione').getDevices();
  } catch (err) {
    return null; // driver not ready yet
  }
  const local = (device) => typeof device._isCloudOnly === 'function' && !device._isCloudOnly();
  return devices.find(local) || devices[0] || null;
}

module.exports = {

  /**
   * GET /?day=today|tomorrow. Always answers with a `state` instead of
   * throwing, so the widget can say in words why there is nothing to draw.
   */
  async getPrices({ homey, query }) {
    const day = query && query.day === 'tomorrow' ? 'tomorrow' : 'today';
    const answer = { day, language: homey.i18n.getLanguage() };

    const device = mainDevice(homey);
    if (!device || typeof device.getPriceCurve !== 'function') return { ...answer, state: 'no_device' };
    if (device.getSetting('price_enabled') === false) return { ...answer, state: 'disabled' };
    if (!device.getPriceZone()) return { ...answer, state: 'no_zone' };

    const curve = await device.getPriceCurve(day);
    if (!curve) return { ...answer, state: day === 'tomorrow' ? 'not_yet' : 'no_prices' };

    return {
      ...answer,
      state: 'ok',
      zone: curve.zone,
      planText: curve.planText,
      dayLow: curve.dayLow,
      dayHigh: curve.dayHigh,
      dischargeFloor: curve.dischargeFloor,
      // Only what a bar needs: 96 quarters go over the wire every minute.
      slots: curve.hours.map((slot) => ({
        from: slot.from,
        till: slot.till,
        price: slot.price,
        verdict: (slot.buy && 'buy') || (slot.sell && 'sell') || (slot.peak && 'peak')
          || (slot.discharge && 'later') || 'hold',
        now: slot.now,
      })),
    };
  },

};
