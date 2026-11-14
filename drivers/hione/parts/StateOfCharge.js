'use strict';

/**
 * The state of charge the device shows and acts on: the reading from the
 * battery, checked against the energy that actually flowed.
 *
 * Part of HiOneDevice. The methods of this class are copied onto the
 * device's prototype at the end of device.js, so `this` is the device itself
 * and they can call, and be called by, everything else on it. This is one
 * class written in several files to keep each readable - nothing here is a
 * separate object at runtime.
 */

const FrankPrices = require('../../../lib/FrankPrices');

// A state-of-charge reading is checked against the battery energy that flowed
// since the last trusted one. Further off than this (percentage points) and it
// is not believed: a pack cannot drop 41% while it sits idle. Wide enough for
// power-measurement error and the BMS correcting itself.
const SOC_ENERGY_TOLERANCE_PCT = 10;

// A reading that keeps disagreeing this long, steadily, wins after all: then
// the last trusted value was the wrong one (or the BMS recalibrated).
const SOC_REANCHOR_MS = 60 * 60_000;

// Readings this far apart cannot be bridged by integrating the power between
// them (Homey restart, long outage): the next reading is taken as it is.
const SOC_INTEGRATION_GAP_MS = 10 * 60_000;

class StateOfCharge {

  /**
   * The state of charge to show and to act on, given one poll's data.
   *
   * Every hold, reserve and price decision keys off this number, so a wrong one
   * is expensive: 44% shown for a pack at 85% (2026-10-10) set the reserve to
   * 45. The stick's own rate check (HoymilesModbus) catches single bad reads;
   * this catches a wrong value that keeps coming, by comparing it with the
   * energy that actually went in or out since the last trusted reading.
   *
   * Returns the reading when it fits, an estimate (last trusted + energy) when
   * it does not or when there is none, and null when nothing is known yet.
   */
  _trustedSoc(data, now = Date.now()) {
    const reported = Number.isFinite(data.batterySoc) ? data.batterySoc : null;
    const power = Number.isFinite(data.batteryPower) ? data.batteryPower : null;
    // A whole-cloud fallback on a device that normally reads the stick carries
    // the cloud's snapshot, which may be hours old: its power is not integrated
    // and its SoC can confirm the estimate but never become the reference.
    const fromCloud = data.source === 'cloud' && !this._isCloudOnly();
    const powerUsable = power !== null && !fromCloud;
    const state = this._soc || (this._soc = { anchor: null, at: 0, energyWh: 0, lastPower: null, lastAt: 0, powerAt: 0, reject: null });

    // Bridge the time since the previous poll with the battery power (+ = charging).
    const gap = now - state.lastAt;
    // The integration is broken once no usable power has come in for longer than
    // a gap - whether the polls stopped or kept arriving from the cloud alone
    // while the stick was down. Timing the polls alone missed the second case:
    // the estimate froze for as long as the stick was away, and the stick's own
    // value was refused when it came back (review 2026-10-27).
    if (state.powerAt && now - state.powerAt > SOC_INTEGRATION_GAP_MS) state.anchor = null;
    if (powerUsable) state.powerAt = now;
    if (state.anchor !== null && powerUsable && state.lastPower !== null) {
      state.energyWh += ((state.lastPower + power) / 2) * (gap / 3_600_000);
    }
    state.lastPower = powerUsable ? power : null;
    state.lastAt = now;

    const trust = (value) => {
      state.anchor = value;
      state.at = now;
      state.energyWh = 0;
      state.reject = null;
      return value;
    };
    // Right after a start the stick may not be connected yet and the reading
    // is the cloud's - 44% on 2026-10-10 10:50 with the pack at 82%. Wait for
    // the stick rather than take that as the reference; the tile keeps its
    // last value meanwhile.
    if (state.anchor === null) return reported === null || fromCloud ? null : trust(reported);

    const capacity = this.getSetting('price_capacity_kwh');
    const capacityKwh = Number.isFinite(capacity) && capacity > 0 ? capacity : FrankPrices.DEFAULTS.capacityKwh;
    const expected = Math.max(0, Math.min(100, state.anchor + state.energyWh / (capacityKwh * 10)));
    const estimate = Math.round(expected * 10) / 10;
    // Not even a close cloud reading re-anchors: a stale 44 accepted as "close
    // enough" on every poll would pin the estimate there while the pack moves.
    if (reported === null || fromCloud) return estimate;
    if (Math.abs(reported - expected) <= SOC_ENERGY_TOLERANCE_PCT) return trust(reported);

    // Disagrees. A new or different disagreement starts its own clock; the same
    // one sustained long enough is believed after all. "The same" is the offset
    // from the estimate, not the reading: a pack that is charging moves its
    // reading every few minutes, which restarted the clock on every move and
    // kept a wrong estimate until the battery sat idle for an hour.
    const offset = reported - expected;
    if (!state.reject || Math.abs(offset - state.reject.offset) > 3) {
      state.reject = { offset, since: now };
      this.log(`SoC ${reported}% ignored: the battery energy since ${state.anchor}% points to ~${estimate}%`);
    } else if (now - state.reject.since >= SOC_REANCHOR_MS) {
      this.log(`SoC ${reported}% accepted after ${Math.round(SOC_REANCHOR_MS / 60_000)} min of steady readings (estimate was ~${estimate}%)`);
      return trust(reported);
    }
    return estimate;
  }

}

module.exports = StateOfCharge;
