'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const HoymilesApi = require('../lib/HoymilesApi');

// Two rows per code, as the public dictionary sends them: namespace 1001 holds
// the title, 1006 the troubleshooting steps.
const DICTIONARY = {
  status: '0',
  data: [
    { ns_id: 1001, key: '10383', en_us: 'BMS Communication Fault', nl_nl: 'Communicatiestoring BMS-CAN' },
    { ns_id: 1006, key: '10383', en_us: '1. Check the cable.', nl_nl: '1. Controleer de kabel.' },
    { ns_id: 1001, key: '21020', en_us: 'Battery Undervoltage', nl_nl: '' },
  ],
};

function api() {
  const calls = [];
  const instance = new HoymilesApi({ log: () => {}, error: () => {} });
  instance.getDeviceTree = async () => ({
    devices: [
      { type: 'DTU', serial: '430526031560', warnData: { connect: true, warn: false } },
      { type: 'Inverter', serial: '228326070241', model: 'HiOne-16T-G3', warnData: { connect: true, warn: true } },
      { type: 'Gateway', serial: '28E026139819' },
    ],
  });
  instance.alarmReply = { status: '0', data: { list: [{ warn_code: 10383, start_at: '2026-11-15 09:12:00' }] } };
  instance.emptyReply = { status: '0', data: { page: 1, page_size: 50, total: 0, list: [] } };
  instance._request = async (method, endpoint, body, authenticated) => {
    calls.push({ endpoint, body, authenticated });
    if (endpoint.includes('/dict/')) return DICTIONARY;
    if (endpoint.endsWith('/flesw')) return instance.alarmReply;
    if (endpoint.endsWith('/flsw')) return instance.stationReply || instance.emptyReply;
    if (endpoint.endsWith('/fleswh')) return instance.historyReply || instance.emptyReply;
    if (endpoint.endsWith('/user/me')) return { status: '0', data: { type: instance.userType ?? 6 } };
    return instance.emptyReply;
  };
  return { instance, calls };
}

test('active alarms come back with the Dutch title and steps for the code', async () => {
  const { instance, calls } = api();
  const result = await instance.getActiveAlarms(14239820, 'nl');

  assert.equal(result.alarms.length, 1);
  assert.deepEqual(result.alarms[0], {
    code: '10383', since: '2026-11-15 09:12:00', until: null,
    title: 'Communicatiestoring BMS-CAN', advice: '1. Controleer de kabel.',
    serial: '228326070241',
  });
  // The station list, the DTU and the inverter are asked; the gateway is not.
  const alarmCalls = calls.filter((c) => c.endpoint.includes('/monitor/'));
  assert.equal(result.userType, 6);
  assert.deepEqual(alarmCalls.slice(0, 3).map((c) => [c.endpoint.split('/').pop(), c.body]), [
    ['flsw',  { sid: 14239820, page: 1, page_size: 50 }],
    ['fldw',  { sid: 14239820, sn: '430526031560', page: 1, page_size: 50 }],
    ['flesw', { sid: 14239820, sn: '228326070241', page: 1, page_size: 50 }],
  ]);
  // Then the inverter's history of the last six days, in two-day windows
  // (the cloud refuses a longer span), newest first and without overlap.
  const windows = alarmCalls.slice(3);
  assert.equal(windows.length, 3);
  for (const w of windows) {
    assert.ok(w.endpoint.endsWith('/fleswh'));
    assert.equal(w.body.sn, '228326070241');
    assert.match(w.body.start_at, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
    assert.equal((Date.parse(w.body.end_at) - Date.parse(w.body.start_at)) / 86400000, 1);
  }
  assert.equal((Date.parse(windows[0].body.start_at) - Date.parse(windows[1].body.end_at)) / 86400000, 1);
  // The portal's flags show which device raised it.
  assert.deepEqual(result.flags.map((f) => [f.serial, f.warn.warn]), [['430526031560', false], ['228326070241', true]]);
});

test('an alarm only the station list knows still comes through, once', async () => {
  const { instance } = api();
  instance.alarmReply = instance.emptyReply;
  instance.stationReply = { status: '0', data: { list: [
    { sn: '228326070241', warn_code: 10383, start_at: '2026-11-15 09:12:00' },
  ] } };
  const result = await instance.getActiveAlarms(14239820, 'nl');
  assert.equal(result.alarms.length, 1);
  assert.equal(result.alarms[0].serial, '228326070241');
  assert.equal(result.alarms[0].title, 'Communicatiestoring BMS-CAN');
});

test('the same alarm from the station list and the inverter is shown once', async () => {
  const { instance } = api();
  instance.stationReply = instance.alarmReply;
  const result = await instance.getActiveAlarms(14239820, 'nl');
  assert.equal(result.alarms.length, 1);
  assert.equal(result.alarms[0].serial, '228326070241');
});

test('the dictionary is public, asked once per language, and falls back to English per code', async () => {
  const { instance, calls } = api();
  const texts = await instance.getAlarmTexts('nl');
  await instance.getAlarmTexts('nl');

  const dictCalls = calls.filter((c) => c.endpoint.includes('/dict/'));
  assert.equal(dictCalls.length, 1);
  assert.equal(dictCalls[0].authenticated, false);
  assert.deepEqual(dictCalls[0].body, { lang_list: ['nl_nl', 'en_us'], ns_ids: [1001, 1006] });
  assert.equal(texts.get('21020').title, 'Battery Undervoltage');
});

test('a reply shaped as a bare array with an unfamiliar code field still yields the code', () => {
  const { instance } = api();
  const parsed = instance._parseAlarmList([{ wcode_id: '10383', s_time: 1794730000 }, { note: 'no code' }]);
  assert.deepEqual(parsed, [{ code: '10383', since: 1794730000, until: null }]);
});

test('an empty list is no alarms, not an error', async () => {
  const { instance } = api();
  instance.alarmReply = instance.emptyReply;
  const result = await instance.getActiveAlarms(14239820, 'en');
  assert.deepEqual(result.alarms, []);
});

test('codes still come through when the dictionary cannot be reached', async () => {
  const { instance } = api();
  const request = instance._request;
  instance._request = async (method, endpoint, ...rest) => {
    if (endpoint.includes('/dict/')) throw new Error('Network error');
    return request(method, endpoint, ...rest);
  };
  const result = await instance.getActiveAlarms(14239820, 'nl');
  assert.equal(result.alarms[0].code, '10383');
  assert.equal(result.alarms[0].title, null);
});

test('a refused alarm request is reported as an error', async () => {
  const { instance } = api();
  const request = instance._request;
  instance._request = async (method, endpoint, ...rest) => {
    if (endpoint.includes('/monitor/')) throw new Error('API error on /monitor/api/0/ng/dev/flesw: no permission');
    return request(method, endpoint, ...rest);
  };
  await assert.rejects(instance.getActiveAlarms(14239820, 'nl'), /Alarms could not be read: .*no permission/);
});

test('Homey languages map onto the dictionary keys', () => {
  assert.equal(HoymilesApi.dictionaryLanguage('nl'), 'nl_nl');
  assert.equal(HoymilesApi.dictionaryLanguage('de'), 'de_de');
  assert.equal(HoymilesApi.dictionaryLanguage('en'), 'en_us');
  assert.equal(HoymilesApi.dictionaryLanguage(undefined), 'en_us');
});

test('the documented reply, one entry per device with its warns, yields each warn', () => {
  const { instance } = api();
  const parsed = instance._parseAlarmList({ total: 1, list: [
    { name: 'HiOne-16T-G3', sn: '228326070241', track_time: '2026-11-15 09:00:00',
      warns: [{ code: 10383, time: '2026-11-15 09:12:00', wd1: 0 }, { code: 21020, time: '2026-11-15 09:13:00' }] },
  ] });
  assert.deepEqual(parsed, [
    { serial: '228326070241', code: '10383', since: '2026-11-15 09:12:00', until: null },
    { serial: '228326070241', code: '21020', since: '2026-11-15 09:13:00', until: null },
  ]);
});

test('an inverter in alarm while every list is empty is reported without a code', async () => {
  const { instance } = api();
  instance.alarmReply = instance.emptyReply;
  const result = await instance.getActiveAlarms(14239820, 'nl');
  assert.deepEqual(result.alarms, []);
  assert.deepEqual(result.flaggedWithoutCode, [{ serial: '228326070241', type: 'Inverter', model: 'HiOne-16T-G3' }]);
});

test('a flagged inverter whose alarm has a code is not reported twice', async () => {
  const { instance } = api();
  const result = await instance.getActiveAlarms(14239820, 'nl');
  assert.deepEqual(result.flaggedWithoutCode, []);
});

test('an alarm still open in the history counts as active, with its code', async () => {
  const { instance } = api();
  instance.alarmReply = instance.emptyReply;
  instance.historyReply = { status: '0', data: { list: [
    { sn: '228326070241', err_code: 10383, start_at: '2026-11-15 09:12:00 +01:00', end_at: null },
    { sn: '228326070241', err_code: 21020, start_at: '2026-11-13 07:00:00 +01:00', end_at: '2026-11-13 07:05:00 +01:00' },
  ] } };
  const result = await instance.getActiveAlarms(14239820, 'nl');
  assert.deepEqual(result.alarms.map((a) => [a.code, a.title, a.serial]), [['10383', 'Communicatiestoring BMS-CAN', '228326070241']]);
  assert.deepEqual(result.flaggedWithoutCode, []);
  // Each window returns the same rows here; they are shown once.
  assert.deepEqual(result.history.map((a) => a.code), ['10383', '21020']);
});

test('a history that cannot be read does not stop the active alarms', async () => {
  const { instance } = api();
  const request = instance._request;
  instance._request = async (method, endpoint, ...rest) => {
    if (endpoint.endsWith('/fleswh')) throw new Error('API error: no permission');
    return request(method, endpoint, ...rest);
  };
  const result = await instance.getActiveAlarms(14239820, 'nl');
  assert.equal(result.alarms[0].code, '10383');
  assert.match(result.devices.find((d) => d.type === 'Inverter').history.error, /no permission/);
});

test('a DIY account sends ut 5 with the device and history lists, as the portal does', async () => {
  const { instance, calls } = api();
  instance.userType = 5;
  await instance.getActiveAlarms(14239820, 'nl');
  const lists = calls.filter((c) => /[/](flesw|fldw|fleswh)$/.test(c.endpoint));
  assert.ok(lists.length >= 3);
  assert.ok(lists.every((c) => c.body.ut === 5));
});

test('an unreadable account type leaves ut out and still reads the alarms', async () => {
  const { instance, calls } = api();
  const request = instance._request;
  instance._request = async (method, endpoint, ...rest) => {
    if (endpoint.endsWith('/user/me')) throw new Error('API error: no permission');
    return request(method, endpoint, ...rest);
  };
  const result = await instance.getActiveAlarms(14239820, 'nl');
  assert.equal(result.userType, null);
  assert.equal(result.alarms[0].code, '10383');
  assert.ok(calls.filter((c) => c.endpoint.includes('/monitor/')).every((c) => !('ut' in c.body)));
});
