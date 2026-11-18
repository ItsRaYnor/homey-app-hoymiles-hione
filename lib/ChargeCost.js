'use strict';

/**
 * What the charge on board cost, per kWh: a running weighted average.
 *
 * The price plan used to judge every discharge against the cheapest price of
 * the day (or of tomorrow), as if the battery were still to be filled. A charge
 * bought last night at 21 ct is not: it has been paid for, and on a day that
 * runs 33-44 ct it pays to spend it all day long. Tomorrow's own low put the
 * floor at 47.7 ct and the plan said "do nothing" for 24 hours (2026-11-18).
 *
 * The average is kept per poll, from the battery power and the grid power:
 *
 * - Charging from the grid costs the all-in price of that quarter.
 * - Charging from the sun costs what that kWh would have earned on the grid:
 *   the price of that quarter minus the export penalty. That is the same
 *   export value the plan sells against, so the two cannot disagree.
 * - Discharging takes kWh off at the average, which leaves the average as it is.
 *
 * Which part of a charge came from the grid is not measured, so it is taken as
 * what the grid delivered, up to the charge power: the house is assumed to eat
 * the sun first. That is the cautious side - it can only make the charge look
 * dearer than it was, never cheaper.
 *
 * It is weighed over the charge ABOVE the discharge floor: what sits below it
 * is never traded, and blending it in would let one old purchase decide the
 * value of every new one. Once the battery is down at the floor, the next
 * charge sets the average afresh.
 */

// Readings further apart than this are not bridged (restart, outage): the
// power at one end says nothing about what happened in between.
const MAX_GAP_MS = 10 * 60 * 1000;

class ChargeCost {

  /**
   * One poll's worth of bookkeeping. Pure: returns the next state.
   *
   * @param {{avg: ?number, lastAt: ?number}|null} state
   * @param {object} reading
   * @param {number} reading.now
   * @param {?number} reading.batteryW   + charging, - discharging
   * @param {?number} reading.gridW      + importing, - exporting
   * @param {?number} reading.price      all-in EUR/kWh of the running quarter
   * @param {?number} reading.exportValue what a kWh exported now earns, EUR/kWh
   * @param {?number} reading.usableKwh  charge above the floor, after this poll
   * @param {?number} reading.fallback   cost to assume for an untracked charge
   */
  static step(state, { now, batteryW, gridW, price, exportValue, usableKwh, fallback }) {
    const avg = state && Number.isFinite(state.avg) ? state.avg : null;
    const lastAt = state && Number.isFinite(state.lastAt) ? state.lastAt : null;
    const next = { avg, lastAt: now };
    if (lastAt === null || now <= lastAt || now - lastAt > MAX_GAP_MS) return next;
    if (!Number.isFinite(batteryW) || batteryW <= 0) return next;
    if (!Number.isFinite(price)) return next;

    const hours = (now - lastAt) / 3600000;
    const chargedKwh = batteryW / 1000 * hours;
    const fromGrid = Math.min(batteryW, Math.max(0, Number.isFinite(gridW) ? gridW : 0)) / batteryW;
    const sunValue = Number.isFinite(exportValue) ? exportValue : price;
    const value = fromGrid * price + (1 - fromGrid) * sunValue;

    // Without the state of charge there is nothing to weigh against.
    if (!Number.isFinite(usableKwh)) return next;
    const before = Math.max(0, usableKwh - chargedKwh);
    if (before <= 0) {
      next.avg = value;
      return next;
    }
    const known = avg !== null ? avg : (Number.isFinite(fallback) ? fallback : value);
    next.avg = (known * before + value * chargedKwh) / (before + chargedKwh);
    return next;
  }

}

module.exports = ChargeCost;
module.exports.MAX_GAP_MS = MAX_GAP_MS;
