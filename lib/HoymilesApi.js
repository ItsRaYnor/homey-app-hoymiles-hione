'use strict';

/**
 * DISCLAIMER
 * ----------
 * This library communicates with the Hoymiles S-Miles Cloud API.
 * This is an UNOFFICIAL integration — not affiliated with, endorsed by,
 * or supported by Hoymiles Power Electronics Inc.
 *
 * The API is reverse-engineered from observed S-Miles Cloud behaviour.
 * Endpoint paths, payloads and auth flow mirror the verified implementation
 * of github.com/Philra94/homeassistant-hoymiles-cloud (MIT).
 * Hoymiles may change or discontinue this API at any time without notice.
 * Use at your own risk.
 *
 * Credentials are stored in Homey's encrypted device store and are only
 * transmitted to the official Hoymiles S-Miles Cloud API (neapi.hoymiles.com).
 */

const { createHash } = require('crypto');
const { argon2id }   = require('hash-wasm');

const DEFAULT_BASE_URL = 'https://neapi.hoymiles.com';

const ENDPOINTS = {
  // Auth (v3 browser flow + legacy v0 fallback)
  PRE_INSP_V3:     '/iam/pub/3/auth/pre-insp',
  LOGIN_V3:        '/iam/pub/3/auth/login',
  LOGIN_V0:        '/iam/pub/0/auth/login',
  // Stations & telemetry
  STATIONS:        '/pvm/api/0/station/select_by_page',
  REAL_DATA:       '/pvm-data/api/0/station/data/count_station_real_data',
  DEVICE_TREE:     '/pvm/api/0/station/select_device_of_tree',
  // Battery settings (async read via job id, direct write)
  SETTING_READ:    '/pvm-ctl/api/0/dev/setting/read',
  SETTING_WRITE:   '/pvm-ctl/api/0/dev/setting/write',
  SETTING_STATUS:  '/pvm-ctl/api/0/dev/setting/status',
  SETTING_RULE:    '/pvm/api/0/station/setting_rule',
  BATTERY_CONFIG:  '/pvm/api/0/station/setting/battery_config',
  // EPS savings counters
  EPS_PROFIT:      '/eps/api/0/record/stat_a',
};

// Some accounts only accept logins that identify as a known Hoymiles client.
// Tried in order; the matching profile's headers are reused on data requests.
//
// The "home" profile is for consumer accounts ("The account can only be used
// for logging in to the S-Miles Home app"). The gate is passed by the genuine
// app User-Agent "sma/ad/{version}/{tid}/{dc}" (tid 159 = HOYMILES). Auth must
// go directly to the EU consumer gateway — the standard host 307-redirects
// auth, which invalidates the pre-insp nonce. Data endpoints then work on the
// standard host with the issued token.
const CLIENT_PROFILES = [
  {
    name: 'web',
    headers: { 'User-Agent': 'Homey-HoymilesHiOne' },
  },
  {
    name: 'installer',
    headers: {
      'User-Agent':    'S-Miles Installer/3.7.1',
      'App-Version':   '3.7.1',
      'X-App-Version': '3.7.1',
      'X-Client-Type': 'mobile',
    },
  },
  {
    name: 'home',
    headers: { 'User-Agent': 'sma/ad/2.10.0/159/0' },
    authBaseUrl: 'https://euapi.hoymiles.com',
  },
];

// Battery work modes as used by the S-Miles Cloud (verified, 1-based)
const BATTERY_MODES = {
  1: 'Self-Consumption',
  2: 'Economy',
  3: 'Backup',
  4: 'Off-Grid',
  5: 'Force Charge',
  6: 'Force Discharge',
  7: 'Peak Shaving',
  8: 'Time of Use',
};

// Per-mode key inside the settings payload ("k_1".."k_8")
const MODE_KEYS = Object.fromEntries(Object.keys(BATTERY_MODES).map(m => [m, `k_${m}`]));

// Minimal payloads accepted by the cloud when no stored settings exist yet
const DEFAULT_MODE_SETTINGS = {
  1: { reserve_soc: 10 },
  2: { reserve_soc: 10, money_code: '$', date: [] },
  3: { reserve_soc: 100 },
  4: {},
  5: { reserve_soc: 70, max_power: 50 },
  6: { reserve_soc: 30, max_power: 50 },
  7: { reserve_soc: 30, max_soc: 70, meter_power: 3000 },
  8: { reserve_soc: 10 },
};

const BATTERY_SETTINGS_ACTION_ID  = 1013;
const RELAY_SETTINGS_ACTION_ID    = 1014;
const SETTING_STATUS_RUNNING      = 2;
const SETTING_STATUS_SUCCESS      = 0;
const SETTING_MAX_POLLS           = 20;     // the DTU sometimes takes >10s to answer
const SETTING_POLL_INTERVAL_MS    = 1_500;  // → up to ~30s total

const TOKEN_LIFETIME_MS = 2 * 60 * 60 * 1000;  // cloud tokens are valid ~2h
const AUTH_COOLDOWN_MS  = 30 * 60 * 1000;      // back off after a normal failed login
const AUTH_FATAL_COOLDOWN_MS = 12 * 60 * 60 * 1000; // long back-off for lockout/account-type errors

// Errors where retrying soon only makes things worse (account lockout, wrong
// account type, bad credentials) → wait much longer / until a manual login.
const FATAL_AUTH_PATTERNS = [
  /daily maximum/i,
  /exceeds the daily/i,
  /installer\/administrator/i,
  /installer or administrator/i,
  /check your account and password/i,
  /account and password/i,
];

class HoymilesApi {

  constructor({ log, error, baseUrl }) {
    this.log   = log;
    this.error = error;
    this._baseUrl        = baseUrl || DEFAULT_BASE_URL;
    this._token          = null;
    this._tokenExpiry    = null;
    this._profileHeaders = CLIENT_PROFILES[0].headers;
    this._authCooldownUntil = 0;
    this._lastAuthError     = null;
  }

  // ── Authentication ────────────────────────────────────────────────────────
  //
  // The modern web app uses a two-step v3 flow:
  //   1. POST pre-insp { u } → { n: nonce, a: optional salt }
  //   2. POST login { u, ch: credentialHash, n }
  // Without a salt the observed hash variants are
  //   md5(pw) + "." + base64(sha256(pw))   and   hex(sha256(pw)).
  // Salted accounts require Argon2id, which is not feasible on Homey without
  // a native dependency — those fall through to the legacy v0 MD5 login.

  async login(email, password) {
    if (!email || !password) throw new Error('Email and password are required');

    const attempts = [];

    for (const profile of CLIENT_PROFILES) {
      try {
        const token = await this._loginV3(email, password, profile);
        if (token) {
          this._profileHeaders = profile.headers;
          return this._storeToken(token, `v3 ${profile.name}`);
        }
      } catch (err) {
        attempts.push(`v3 ${profile.name}: ${err.message}`);
      }
    }

    try {
      const token = await this._loginLegacy(email, password);
      if (token) {
        this._profileHeaders = CLIENT_PROFILES[0].headers;
        return this._storeToken(token, 'legacy v0');
      }
    } catch (err) {
      attempts.push(`v0: ${err.message}`);
    }

    // Back off so a failing/locked account isn't hammered every poll. Fatal
    // errors (daily lockout, wrong account type, bad credentials) back off long.
    const detail = attempts.join('; ');
    const fatal  = FATAL_AUTH_PATTERNS.some(re => re.test(detail));
    this._authCooldownUntil = Date.now() + (fatal ? AUTH_FATAL_COOLDOWN_MS : AUTH_COOLDOWN_MS);
    this._lastAuthError = 'Login failed — check your S-Miles Cloud email and password'
      + (attempts.length ? ` (${detail})` : '');
    if (fatal) this.log('[HoymilesApi] Fatal auth error — backing off 12h to protect the account');
    throw new Error(this._lastAuthError);
  }

  async _loginV3(email, password, profile) {
    // Consumer accounts must authenticate against their regional gateway
    const authBase = profile.authBaseUrl || this._baseUrl;

    const preInspect = async () => {
      const pre = await this._request('POST', `${authBase}${ENDPOINTS.PRE_INSP_V3}`,
        { u: email }, false, profile.headers);
      const preData = pre?.data ?? pre;
      if (!preData?.n) throw new Error('pre-insp returned no nonce');
      return preData;
    };

    let preData = await preInspect();

    // Salted account → browser computes an Argon2id hash over password + salt
    if (preData.a) {
      const ch = await this._argon2Hash(password, preData.a);
      const resp = await this._request('POST', `${authBase}${ENDPOINTS.LOGIN_V3}`,
        { u: email, ch, n: preData.n }, false, profile.headers);
      return resp?.data?.token ?? null;
    }

    // No salt → try the observed unsalted hash variants
    const md5Hex    = createHash('md5').update(password).digest('hex');
    const sha256B64 = createHash('sha256').update(password).digest('base64');
    const sha256Hex = createHash('sha256').update(password).digest('hex');

    const candidates = [
      `${md5Hex}.${sha256B64}`, // dotted md5 + base64(sha256) variant
      sha256Hex,                // plain sha256 hex variant
    ];

    for (let i = 0; i < candidates.length; i++) {
      // Each login attempt consumes the nonce, so re-inspect per retry
      if (i > 0) preData = await preInspect();

      try {
        const resp = await this._request('POST', `${authBase}${ENDPOINTS.LOGIN_V3}`,
          { u: email, ch: candidates[i], n: preData.n }, false, profile.headers);
        const token = resp?.data?.token;
        if (token) return token;
      } catch (_) {
        // try next hash variant
      }
    }
    return null;
  }

  /**
   * Argon2id credential hash for salted v3 logins (matches the S-Miles
   * web client: t=3, m=32768 KiB, p=1, 32-byte hash, hex output).
   */
  async _argon2Hash(password, saltValue) {
    return argon2id({
      password,
      salt: this._decodeSalt(saltValue),
      iterations:  3,
      memorySize:  32768,
      parallelism: 1,
      hashLength:  32,
      outputType:  'hex',
    });
  }

  // Observed salt formats: plain hex (browser captures) or base64
  _decodeSalt(saltValue) {
    const s = String(saltValue).trim();
    if (s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s)) return Buffer.from(s, 'hex');
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return Buffer.from(s, 'base64');
    return Buffer.from(s, 'utf8');
  }

  async _loginLegacy(email, password) {
    const md5Hex = createHash('md5').update(password).digest('hex');
    const resp = await this._request('POST', ENDPOINTS.LOGIN_V0,
      { user_name: email, password: md5Hex }, false);
    return resp?.data?.token ?? null;
  }

  _storeToken(token, method) {
    this._token       = token;
    this._tokenExpiry = Date.now() + TOKEN_LIFETIME_MS;
    this._authCooldownUntil = 0;
    this._lastAuthError     = null;
    this.log(`[HoymilesApi] Login successful (${method})`);
    return true;
  }

  async ensureToken(email, password) {
    if (this._token && Date.now() < (this._tokenExpiry ?? 0)) return;
    // Respect the cooldown after a failed login (manual login() bypasses this)
    if (Date.now() < this._authCooldownUntil) {
      const mins = Math.ceil((this._authCooldownUntil - Date.now()) / 60000);
      throw new Error((this._lastAuthError || 'Login failed')
        + ` — not retrying for ~${mins} min`);
    }
    await this.login(email, password);
  }

  // ── Stations ──────────────────────────────────────────────────────────────

  async getStations() {
    const stations = [];
    let pageNum = 1;
    const pageSize = 100;

    for (;;) {
      const response = await this._request('POST', ENDPOINTS.STATIONS,
        { page_num: pageNum, page_size: pageSize });
      const data = response?.data;
      // Accounts without a registered station return no list array
      const list = Array.isArray(data?.list) ? data.list : [];
      if (list.length === 0) break;

      for (const s of list) {
        stations.push({ id: String(s.id), name: s.name || `Station ${s.id}`, sn: s.sn || '' });
      }

      const total = Number(data?.total ?? NaN);
      if (!isNaN(total) && stations.length >= total) break;
      if (list.length < pageSize) break;
      pageNum++;
    }
    return stations;
  }

  // ── Real-time data ────────────────────────────────────────────────────────

  /**
   * Single call returning live power flows AND energy counters.
   * Energy values arrive in Wh and are converted to kWh here.
   */
  async getRealData(stationId) {
    const response = await this._request('POST', ENDPOINTS.REAL_DATA, { sid: Number(stationId) });
    const d = response?.data;
    if (!d) throw new Error('Empty real-data response');

    const reflux = d.reflux_station_data || {};

    return {
      pvPower:        this._num(d.real_power ?? d.pv_power ?? 0),
      // Cloud bms_power is positive while CHARGING and negative while
      // discharging — the same convention Homey uses for a home battery
      // (positive = charging). Use it as-is so measure_power, the
      // charge/discharge status and Homey Energy all match.
      // Verified against real hardware (cloud source) on 2026-06-18.
      batteryPower:   this._num(reflux.bms_power ?? 0),
      batterySoc:     this._num(reflux.bms_soc ?? 0),
      gridPower:      this._num(reflux.grid_power ?? 0),
      loadPower:      this._num(reflux.load_power ?? 0),
      dailyEnergy:    this._kwh(d.today_eq ?? 0),
      monthlyEnergy:  this._kwh(d.month_eq ?? 0),
      yearlyEnergy:   this._kwh(d.year_eq ?? 0),
      totalEnergy:    this._kwh(d.total_eq ?? 0),
      batteryInEnergy:  this._kwh(reflux.bms_in_eq ?? 0),
      batteryOutEnergy: this._kwh(reflux.bms_out_eq ?? 0),
      co2Reduction:   this._num(d.co2_emission_reduction ?? 0) / 1000, // g → kg
      batteryMode:    null, // mode comes from getBatterySettings()
    };
  }

  // ── Device tree (gateway / DTU identity) ──────────────────────────────────

  /**
   * Map the numeric device `type` to the label the S-Miles portal shows.
   * Falls back to a model-name guess for unknown type codes.
   */
  _deviceTypeName(node, depth) {
    const code = Number(node.type);
    const known = { 1: 'DTU', 6: 'Inverter', 14: 'Gateway' };
    if (known[code]) return known[code];

    const hint = String(node.model_no ?? node.model ?? '').toLowerCase();
    if (depth === 0 || /dtu|dts|stick/.test(hint)) return 'DTU';
    if (/inv|hybrid|hione|hyt/.test(hint))         return 'Inverter';
    if (/hibox|gateway|backup|63t|eps/.test(hint)) return 'Gateway';
    if (/bat|bms|8b|module/.test(hint))            return 'Battery';
    if (/meter|ct|clamp/.test(hint))               return 'Meter';
    return 'Device';
  }

  /**
   * Walk the cloud device tree and collect every node (DTU, inverter, HiBox, …)
   * with all fields the portal lists: type, status, generation, model, serial,
   * firmware and hardware version.
   * @returns {Array<{type,status,gen,model,serial,softwareVer,hardwareVer}>}
   */
  _flattenDeviceTree(node, depth = 0) {
    if (!node || typeof node !== 'object') return [];

    const model  = String(node.model_no ?? node.model ?? node.dev_model ?? '').trim();
    const serial = String(node.sn ?? node.dtu_sn ?? node.serial ?? node.dev_sn ?? '').trim();

    // Status from the connection flag the portal uses (warn_data.connect)
    const connect = node.warn_data?.connect;
    const status  = connect === true ? 'Online' : connect === false ? 'Offline' : '';

    // "Device Ver." in the portal = the generation number (version 3 → Gen3)
    const ver = Number(node.version);
    const gen = Number.isFinite(ver) && ver > 0 ? `Gen${ver}` : '';

    const out = [];
    if (model || serial) {
      out.push({
        type:        this._deviceTypeName(node, depth),
        status,
        gen,
        model,
        serial,
        softwareVer: String(node.soft_ver ?? node.firmware ?? ''),
        hardwareVer: String(node.hard_ver ?? node.hardware ?? ''),
      });
    }

    const childKeys = ['child_list', 'children', 'child', 'device_list', 'sub_list', 'list'];
    for (const key of childKeys) {
      const kids = node[key];
      if (!Array.isArray(kids)) continue;
      for (const child of kids) out.push(...this._flattenDeviceTree(child, depth + 1));
    }
    return out;
  }

  /**
   * Fetch the station device tree: gateway identity + all connected devices.
   * The top-level node is the DTU stick (e.g. DTS-WL-G3); children are
   * inverter(s), HiBox/Backup Box, battery modules, etc.
   *
   * Returns { dtuSn, softwareVer, deviceVer, model, devices } or null.
   */
  async getDeviceTree(stationId) {
    const response = await this._request('POST', ENDPOINTS.DEVICE_TREE, { id: Number(stationId) });
    const raw = response?.data;
    const roots = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    if (roots.length === 0) return null;

    const dtu = roots[0];
    const devices = [];
    for (const root of roots) devices.push(...this._flattenDeviceTree(root));
    this.log(`[HoymilesApi] Device tree: ${roots.length} root(s) → ${devices.length} device(s) flattened`);

    // Drop duplicates (same serial)
    const seen = new Set();
    const unique = [];
    for (const d of devices) {
      const key = d.serial || `${d.type}:${d.model}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(d);
    }

    return {
      dtuSn:       String(dtu.sn ?? dtu.dtu_sn ?? ''),
      softwareVer: String(dtu.soft_ver ?? ''),
      deviceVer:   String(dtu.hard_ver ?? ''),
      model:       String(dtu.model_no ?? ''),
      devices:     unique,
    };
  }

  /** @deprecated use getDeviceTree — kept for callers expecting gateway-only info */
  async getDevices(stationId) {
    return this.getDeviceTree(stationId);
  }

  // ── Battery settings (mode + reserve SOC) ─────────────────────────────────

  /**
   * Read the full battery settings payload via the async pvm-ctl endpoint.
   * Returns { mode, reserveSoc, modeData } or null when unavailable.
   */
  async getBatterySettings(stationId) {
    try {
      // The read is rejected with "[Working Mode] pending" right after a mode
      // change while the device applies it — retry a few times before giving up.
      let resolved = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const submitted = await this._request('POST', ENDPOINTS.SETTING_READ, {
            action: BATTERY_SETTINGS_ACTION_ID,
            data:   { sid: Number(stationId) },
          });
          resolved = await this._resolveSettingJob(submitted);
          break;
        } catch (err) {
          if (/pending/i.test(err.message) && attempt < 3) {
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }
          throw err;
        }
      }
      const payload  = resolved?.data?.data;
      if (!payload || typeof payload !== 'object') return null;

      const mode     = Number(payload.mode ?? 1);
      const modeData = payload.data || {};
      const modeKey  = MODE_KEYS[mode];
      const current  = (modeKey && modeData[modeKey]) || {};
      // max_power lives in Force Charge (k_5) / Force Discharge (k_6). Read both
      // from stored settings so the sliders always show the cloud value, even
      // when neither mode is currently active.
      const forceCharge    = modeData['k_5'] || {};
      const forceDischarge = modeData['k_6'] || {};

      // The modes the device actually exposes = the k_N keys present in modeData
      const availableModes = Object.entries(MODE_KEYS)
        .filter(([, key]) => key in modeData)
        .map(([id]) => Number(id));

      this.log(`[HoymilesApi] settings raw mode=${mode} reserve_soc=${current.reserve_soc} `
        + `max_soc=${current.max_soc} max_power=${current.max_power} `
        + `→ pct reserve=${this._pct(current.reserve_soc)} maxSoc=${this._pct(current.max_soc)} maxPower=${this._pct(current.max_power)}`);

      return {
        mode:       String(mode),
        reserveSoc: this._pct(current.reserve_soc),
        maxSoc:     this._pct(current.max_soc),
        maxPower:   this._pct(current.max_power),
        maxChargePower:    this._pct(forceCharge.max_power),
        maxDischargePower: this._pct(forceDischarge.max_power),
        meterPower: this._num(current.meter_power ?? null, null),
        availableModes,
        modeData,
      };
    } catch (err) {
      this.log(`[HoymilesApi] getBatterySettings failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Read the station's setting rules — the cloud's declaration of which
   * controls/modes/ranges this installation supports. Useful for diagnostics.
   */
  async getSettingRules(stationId) {
    try {
      const response = await this._request('POST', ENDPOINTS.SETTING_RULE, { sid: Number(stationId) });
      return (response?.data && typeof response.data === 'object') ? response.data : null;
    } catch (err) {
      this.log(`[HoymilesApi] getSettingRules failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Activate a battery mode. The cloud requires the full per-mode settings
   * payload on every write, so this performs read-merge-write.
   */
  async setBatteryMode(stationId, mode, settingsUpdate = {}, current = null) {
    const modeNum = Number(mode);
    if (!(modeNum in BATTERY_MODES)) throw new Error(`Invalid battery mode: ${mode}`);

    // Reuse a caller-supplied read when available to avoid a second slow read
    if (!current) current = await this.getBatterySettings(stationId);
    // Refuse to write when we couldn't read current settings — falling back to
    // defaults here would overwrite a stored Economy/Time-of-Use schedule.
    if (!current) {
      throw new Error('Could not read current battery settings; not changing mode to avoid overwriting your schedule — please try again');
    }
    const modeKey  = MODE_KEYS[modeNum];
    const existing = current.modeData[modeKey] || { ...DEFAULT_MODE_SETTINGS[modeNum] };
    const merged   = { ...existing, ...settingsUpdate };

    // Activate the mode through the async pvm-ctl control channel (action 1013)
    // and poll the job to completion. The direct battery_config endpoint
    // returns success but does NOT actually change the active working mode on
    // the HiOne — only this channel does (it's the same one the read uses).
    const submitted = await this._request('POST', ENDPOINTS.SETTING_WRITE, {
      action: BATTERY_SETTINGS_ACTION_ID,
      data:   { sid: Number(stationId), data: { mode: modeNum, data: merged } },
    });
    await this._resolveSettingJob(submitted); // throws if the device rejects it
    this.log(`[HoymilesApi] Mode → ${BATTERY_MODES[modeNum]} for station ${stationId} (applied)`);
    return true;
  }

  /**
   * Update the reserve SOC of the currently active battery mode.
   */
  async setReserveSoc(stationId, reserveSoc) {
    const soc = Math.round(Number(reserveSoc));
    if (isNaN(soc) || soc < 0 || soc > 100) throw new Error(`Invalid reserve SOC: ${reserveSoc}`);

    const current = await this.getBatterySettings(stationId);
    if (!current) throw new Error('Battery settings are not readable for this station');

    await this.setBatteryMode(stationId, current.mode, { reserve_soc: soc });
    this.log(`[HoymilesApi] Reserve SOC → ${soc}% for station ${stationId}`);
    return true;
  }

  /**
   * Set Peak Shaving mode parameters and activate that mode.
   * All values optional — only the given fields are updated.
   */
  async setPeakShaving(stationId, { reserveSoc, maxSoc, meterPower } = {}) {
    const updates = {};
    if (reserveSoc !== undefined && reserveSoc !== null) updates.reserve_soc = Math.round(Number(reserveSoc));
    if (maxSoc     !== undefined && maxSoc     !== null) updates.max_soc     = Math.round(Number(maxSoc));
    if (meterPower !== undefined && meterPower !== null) updates.meter_power = Math.round(Number(meterPower));

    for (const [key, value] of Object.entries(updates)) {
      if (isNaN(value)) throw new Error(`Invalid Peak Shaving value for ${key}`);
      if ((key === 'reserve_soc' || key === 'max_soc') && (value < 0 || value > 100)) {
        throw new Error(`Invalid Peak Shaving percentage for ${key}: ${value}`);
      }
    }

    await this.setBatteryMode(stationId, 7, updates);
    this.log(`[HoymilesApi] Peak Shaving updated: ${JSON.stringify(updates)}`);
    return true;
  }

  /**
   * Write one or more scalar parameters into the CURRENTLY ACTIVE mode and
   * re-apply it. Used by the device sliders (max power / max SOC / grid limit).
   * @param {object} updates  e.g. { max_power: 60 } or { max_soc: 80 }
   */
  async setActiveModeSettings(stationId, updates) {
    const current = await this.getBatterySettings(stationId);
    if (!current) throw new Error('Could not read current battery settings — please try again');
    await this.setBatteryMode(stationId, current.mode, updates, current);
    this.log(`[HoymilesApi] Active mode (${BATTERY_MODES[Number(current.mode)]}) updated: ${JSON.stringify(updates)}`);
    return true;
  }

  /**
   * Set the charge/discharge power limit (%) for Force Charge / Force Discharge.
   * Targets the active mode if it's Force Charge (5) or Force Discharge (6);
   * otherwise applies to and activates Force Charge (5). Setting this to 0 in
   * Force Charge stops the battery charging, so it won't absorb power that other
   * sources feed back to the grid (e.g. other batteries discharging on high tariffs).
   */
  async setMaxPower(stationId, percent) {
    const value = Math.round(Number(percent));
    if (isNaN(value) || value < 0 || value > 100) throw new Error(`Invalid max power: ${percent}`);
    const current = await this.getBatterySettings(stationId);
    if (!current) throw new Error('Could not read current battery settings — please try again');
    const mode = [5, 6].includes(Number(current.mode)) ? Number(current.mode) : 5;
    await this.setBatteryMode(stationId, mode, { max_power: value }, current);
    this.log(`[HoymilesApi] Max power → ${value}% (mode ${mode})`);
    return true;
  }

  /**
   * Set the max charge power (%) — the Force Charge (mode 5) limit. Writing it
   * activates Force Charge (the cloud has no way to update a mode's settings
   * without selecting it). Set to 0 to stop the battery charging.
   */
  async setMaxChargePower(stationId, percent) {
    const value = Math.round(Number(percent));
    if (isNaN(value) || value < 0 || value > 100) throw new Error(`Invalid max charge power: ${percent}`);
    await this.setBatteryMode(stationId, 5, { max_power: value });
    this.log(`[HoymilesApi] Max charge power → ${value}% (Force Charge)`);
    return true;
  }

  /**
   * Set the max discharge power (%) — the Force Discharge (mode 6) limit.
   * Writing it activates Force Discharge.
   */
  async setMaxDischargePower(stationId, percent) {
    const value = Math.round(Number(percent));
    if (isNaN(value) || value < 0 || value > 100) throw new Error(`Invalid max discharge power: ${percent}`);
    await this.setBatteryMode(stationId, 6, { max_power: value });
    this.log(`[HoymilesApi] Max discharge power → ${value}% (Force Discharge)`);
    return true;
  }

  /**
   * Set the max SOC (%) on a mode that supports it (Peak Shaving 7).
   * Targets the active mode if it already has max_soc; otherwise Peak Shaving.
   */
  async setMaxSoc(stationId, percent) {
    const value = Math.round(Number(percent));
    if (isNaN(value) || value < 0 || value > 100) throw new Error(`Invalid max SOC: ${percent}`);
    const current = await this.getBatterySettings(stationId);
    if (!current) throw new Error('Could not read current battery settings — please try again');
    const modeKey = MODE_KEYS[Number(current.mode)];
    const supports = current.modeData[modeKey] && 'max_soc' in current.modeData[modeKey];
    const mode = supports ? Number(current.mode) : 7;
    await this.setBatteryMode(stationId, mode, { max_soc: value }, current);
    this.log(`[HoymilesApi] Max SOC → ${value}% (mode ${mode})`);
    return true;
  }

  /**
   * Set the grid power limit (W) — Peak Shaving meter_power.
   */
  async setGridLimit(stationId, watts) {
    const value = Math.round(Number(watts));
    if (isNaN(value) || value < 0) throw new Error(`Invalid grid limit: ${watts}`);
    await this.setBatteryMode(stationId, 7, { meter_power: value });
    this.log(`[HoymilesApi] Grid limit → ${value}W (Peak Shaving)`);
    return true;
  }

  /**
   * Set a single Time-of-Use charge/discharge period and activate ToU (mode 8).
   * Replaces the schedule with this one period (use the S-Miles app for
   * multi-period schedules).
   * @param {object} p { chargeFrom, chargeTo, chargePower, dischargeFrom,
   *                     dischargeTo, dischargePower, chargeSoc, dischargeSoc }
   */
  async setTouPeriod(stationId, p) {
    const hhmm = /^\d{1,2}:\d{2}$/;
    for (const [k, v] of Object.entries({
      chargeFrom: p.chargeFrom, chargeTo: p.chargeTo,
      dischargeFrom: p.dischargeFrom, dischargeTo: p.dischargeTo,
    })) {
      if (!hhmm.test(String(v || ''))) throw new Error(`Invalid time for ${k} (use HH:MM): ${v}`);
    }
    const pct = (v, name) => {
      const n = Math.round(Number(v));
      if (isNaN(n) || n < 0 || n > 100) throw new Error(`Invalid ${name} (0–100): ${v}`);
      return n;
    };
    const period = {
      cs_time:        String(p.chargeFrom),
      ce_time:        String(p.chargeTo),
      c_power:        pct(p.chargePower, 'charge power'),
      dcs_time:       String(p.dischargeFrom),
      dce_time:       String(p.dischargeTo),
      dc_power:       pct(p.dischargePower, 'discharge power'),
      charge_soc:     pct(p.chargeSoc, 'charge SOC'),
      dis_charge_soc: pct(p.dischargeSoc, 'discharge SOC'),
    };
    await this.setBatteryMode(stationId, 8, { time: [period] });
    this.log(`[HoymilesApi] Time of Use period set: ${JSON.stringify(period)}`);
    return true;
  }

  // ── EPS savings ───────────────────────────────────────────────────────────

  /**
   * Fetch EPS profit/savings counters (station currency).
   * Returns { todayProfit, monthlyProfit, yearlyProfit, totalProfit } or null.
   */
  async getEpsProfit(stationId) {
    try {
      const response = await this._request('POST', ENDPOINTS.EPS_PROFIT, { sid: Number(stationId) });
      const d = response?.data;
      if (!d || typeof d !== 'object') return null;
      return {
        todayProfit:   this._num(d.today_profit   ?? null, null),
        monthlyProfit: this._num(d.monthly_profit ?? null, null),
        yearlyProfit:  this._num(d.yearly_profit  ?? null, null),
        totalProfit:   this._num(d.total_profit   ?? null, null),
      };
    } catch (err) {
      this.log(`[HoymilesApi] getEpsProfit failed: ${err.message}`);
      return null;
    }
  }

  // ── Relay / dry contact ───────────────────────────────────────────────────

  /**
   * Read the relay (dry contact) settings payload via the async endpoint.
   * Returns the raw payload object or null when unsupported/unavailable.
   */
  async getRelaySettings(stationId) {
    try {
      const submitted = await this._request('POST', ENDPOINTS.SETTING_READ, {
        action: RELAY_SETTINGS_ACTION_ID,
        data:   { sid: Number(stationId) },
      });
      const resolved = await this._resolveSettingJob(submitted);
      const payload  = resolved?.data?.data;
      return (payload && typeof payload === 'object') ? payload : null;
    } catch (err) {
      this.log(`[HoymilesApi] getRelaySettings failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Enable or disable dry-contact control, preserving the stored payload.
   * Mirrors the HA integration: relay mode 0 = off, 1 = on; per-contact
   * modes live in data.k_2 / data.k_3.
   */
  async setRelayEnabled(stationId, enabled) {
    const payload = await this.getRelaySettings(stationId);
    if (!payload) throw new Error('Relay settings are not readable for this station');

    const nested = (payload.data && typeof payload.data === 'object') ? payload.data : {};
    payload.data = nested;

    if (enabled) {
      if (!payload.mode) payload.mode = 1;
      const k2Mode = nested.k_2?.mode ?? 0;
      const k3Mode = nested.k_3?.mode ?? 0;
      if (k2Mode === 0 && k3Mode === 0) {
        nested.k_2 = { ...(nested.k_2 || {}), mode: 2 };
      }
    } else {
      payload.mode = 0;
      if (nested.k_2 && typeof nested.k_2 === 'object') nested.k_2.mode = 0;
      if (nested.k_3 && typeof nested.k_3 === 'object') nested.k_3.mode = 0;
    }

    const submitted = await this._request('POST', ENDPOINTS.SETTING_WRITE, {
      action: RELAY_SETTINGS_ACTION_ID,
      data:   { sid: Number(stationId), data: payload },
    });
    await this._resolveSettingJob(submitted);
    this.log(`[HoymilesApi] Relay → ${enabled ? 'enabled' : 'disabled'} for station ${stationId}`);
    return true;
  }

  /**
   * Resolve an async pvm-ctl command: a numeric/string `data` is a job id
   * that must be polled on the status endpoint until it stops RUNNING.
   */
  async _resolveSettingJob(response) {
    const data = response?.data;
    if (typeof data !== 'string' && typeof data !== 'number') return response;

    for (let attempt = 0; attempt < SETTING_MAX_POLLS; attempt++) {
      const status = await this._request('POST', ENDPOINTS.SETTING_STATUS, { id: String(data) });
      const code = status?.data?.code;
      if (code !== SETTING_STATUS_RUNNING) {
        if (code !== undefined && code !== null && code !== SETTING_STATUS_SUCCESS) {
          throw new Error(`Setting command failed (code ${code})`);
        }
        return status;
      }
      await new Promise(resolve => setTimeout(resolve, SETTING_POLL_INTERVAL_MS));
    }
    throw new Error('Timed out waiting for setting command');
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  async _request(method, endpoint, body = {}, authenticated = true, profileHeaders = null) {
    const url     = endpoint.startsWith('http') ? endpoint : `${this._baseUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      ...(profileHeaders || this._profileHeaders),
    };
    // The API expects the raw token (no Bearer prefix)
    if (authenticated && this._token) headers['Authorization'] = this._token;

    this.log(`[HoymilesApi] ${method} ${endpoint}`);

    let rawResponse;
    try {
      rawResponse = await fetch(url, {
        method,
        headers,
        body:   JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new Error(`Network error on ${endpoint}: ${err.message}`);
    }

    if (!rawResponse.ok) throw new Error(`HTTP ${rawResponse.status} on ${endpoint}`);

    let json;
    try {
      json = await rawResponse.json();
    } catch (_) {
      throw new Error(`Invalid JSON from ${endpoint}`);
    }

    if (String(json.status ?? '0') !== '0') {
      // Expired/invalid token → drop it so the next call re-authenticates
      if (String(json.status) === '100') this._token = null;
      throw new Error(`API error on ${endpoint}: ${json.message ?? `status ${json.status}`}`);
    }

    return json;
  }

  _num(v, fallback = 0) {
    if (v === null || v === undefined) return fallback;
    const n = parseFloat(v);
    return isNaN(n) ? fallback : Math.round(n * 100) / 100;
  }

  _kwh(v) {
    // Cloud reports energy counters in Wh
    const n = parseFloat(v);
    return isNaN(n) ? 0 : Math.round(n / 10) / 100;
  }

  // Percentage field — the cloud returns some (e.g. max_power) in 0.01%
  // units (67% → 6700). Values above 100 are scaled back to a real percent.
  _pct(v) {
    if (v === null || v === undefined) return null;
    const n = parseFloat(v);
    if (isNaN(n)) return null;
    return n > 100 ? Math.round(n / 100) : Math.round(n);
  }
}

module.exports = HoymilesApi;
module.exports.BATTERY_MODES = BATTERY_MODES;
