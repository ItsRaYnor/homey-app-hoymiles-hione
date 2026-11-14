'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const HoymilesHybrid = require('../lib/HoymilesHybrid');
const HoymilesApi = require('../lib/HoymilesApi');

const LIVE = { batterySoc: 49, batteryPower: 0, batteryVoltage: 26.2, gridPower: 774, pvPower: 1286, loadPower: 2087 };
const STALE_CLOUD = { batterySoc: 49, batteryPower: 0, batteryVoltage: 26.2, gridPower: 4381, pvPower: 0, loadPower: 5484 };

/**
 * A hybrid on Modbus with a cloud login, whose stick answers per the given
 * script: true = a reading, false = no reply.
 */
function hybrid(script) {
  const cloudCalls = [];
  const cloud = {
    ensureToken: async () => {},
    getRealData: async () => { cloudCalls.push('realData'); return { ...STALE_CLOUD }; },
  };
  const instance = new HoymilesHybrid({
    gatewayIp: '192.168.8.160', localProtocol: 'modbus', modbusUnitId: 1,
    email: 'user', password: 'secret', stationId: 1,
    cloudApi: cloud, log: () => {}, error: () => {},
  });
  instance._modbusRetryDelayMs = 0;
  const answers = [...script];
  instance._modbus.getData = async () => {
    if (answers.shift()) return { ...LIVE };
    throw new Error('No reply from the stick for any field');
  };
  // The counter top-up runs every fifth poll; leave it out of these tests.
  instance._mergeCloudEnergy = async () => {};
  return { instance, cloudCalls };
}

test('a stick that misses the first request after a restart gets a second try before the cloud', async () => {
  const { instance, cloudCalls } = hybrid([false, true]);
  const data = await instance.getData();
  assert.equal(data.source, 'modbus_cloud');
  assert.equal(data.gridPower, 774);
  assert.deepEqual(cloudCalls, []);
});

test('a stick that never answers falls back to the cloud at start', async () => {
  const { instance, cloudCalls } = hybrid([false, false]);
  const data = await instance.getData();
  assert.equal(data.source, 'cloud');
  assert.deepEqual(cloudCalls, ['realData']);
});

test('one missed reading after the stick has answered keeps the last values, not the cloud', async () => {
  const { instance, cloudCalls } = hybrid([true, false]);
  await instance.getData();
  await assert.rejects(instance.getData(), /keeping the last values/);
  assert.deepEqual(cloudCalls, []);
});

test('a stick that stays silent hands over to the cloud on the second poll', async () => {
  const { instance, cloudCalls } = hybrid([true, false, false]);
  await instance.getData();
  await assert.rejects(instance.getData());
  const data = await instance.getData();
  assert.equal(data.source, 'cloud');
  assert.deepEqual(cloudCalls, ['realData']);
});

test('the stick coming back wins over the cloud straight away', async () => {
  const { instance } = hybrid([true, false, false, true, false]);
  await instance.getData();
  await assert.rejects(instance.getData());
  assert.equal((await instance.getData()).source, 'cloud');
  assert.equal((await instance.getData()).source, 'modbus_cloud');
  // Back on the stick, a single miss is a hiccup again.
  await assert.rejects(instance.getData(), /keeping the last values/);
});

test('the cloud reports grid power with the same sign as the stick: positive is importing', async () => {
  const api = new HoymilesApi({ log: () => {}, error: () => {} });
  const answer = (gridPower) => ({ data: { reflux_station_data: { grid_power: gridPower, load_power: 500, bms_soc: 50 } } });
  api._request = async () => answer(-811);                     // night: importing 811 W
  assert.equal((await api.getRealData(1)).gridPower, 811);
  api._request = async () => answer(7486);                     // midday: exporting 7.5 kW
  assert.equal((await api.getRealData(1)).gridPower, -7486);
  api._request = async () => answer(0);
  assert.ok(Object.is((await api.getRealData(1)).gridPower, 0)); // idle is 0, never -0
});
