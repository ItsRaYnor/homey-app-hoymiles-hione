'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const HoymilesModbus = require('../lib/HoymilesModbus');

// Decoding and frame building need no connection, so nothing is opened here.
const modbus = new HoymilesModbus({ host: '127.0.0.1', port: 502, unitId: 1, log() {}, error() {} });

test('a signed 16-bit register reads negative above 0x7FFF', () => {
  assert.equal(modbus._decode([0xFFFF], { signed: true }), -1);
  assert.equal(modbus._decode([57536], { signed: true }), -8000);
  assert.equal(modbus._decode([5880], { signed: true }), 5880);
  assert.equal(modbus._decode([0xFFFF], {}), 65535);
});

test('battery power is negated: the stick counts discharging as positive', () => {
  // 57536 raw is -8000: the stick's way of saying "charging 8000 W".
  assert.equal(modbus._decode([57536], { signed: true, scale: -1 }), 8000);
  assert.equal(modbus._decode([5880], { signed: true, scale: -1 }), -5880);
});

test('two registers form one 32-bit value, high word first', () => {
  assert.equal(modbus._decode([0x0001, 0x0000], {}), 65536);
  assert.equal(modbus._decode([0xFFFF, 0xFFFF], { signed: true }), -1);
});

test('per-phase registers are added up, each with its own sign', () => {
  assert.equal(modbus._decode([100, 200, 300], { sum: true }), 600);
  assert.equal(modbus._decode([100, 0xFFFF, 300], { sum: true, signed: true }), 399);
});

test('a scale is applied and rounded to two decimals', () => {
  assert.equal(modbus._decode([523], { scale: 0.1 }), 52.3);
  assert.equal(modbus._decode([3333], { scale: 0.001 }), 3.33);
});

test('a value outside its range is not believed', () => {
  const soc = { min: 0, max: 100 };
  assert.equal(modbus._plausible(50, soc), true);
  assert.equal(modbus._plausible(0, soc), true);
  assert.equal(modbus._plausible(65535, soc), false);   // "no data"
  assert.equal(modbus._plausible(-1, soc), false);
  assert.equal(modbus._plausible(NaN, soc), false);
  assert.equal(modbus._plausible(undefined, soc), false);
});

test('the settings block is refused when the stick answers with nonsense', () => {
  const { words } = HoymilesModbus.EMS_BLOCK;
  const sane = [0, 30, 95, 20, 500, 100, 500];
  assert.equal(sane.length, words);
  assert.equal(modbus._emsBlockSane(sane), true);
  assert.equal(modbus._emsBlockSane(sane.slice(0, 5)), false);            // short frame
  assert.equal(modbus._emsBlockSane(new Array(words).fill(7)), false);    // one value repeated
  assert.equal(modbus._emsBlockSane([9, 30, 95, 20, 500, 100, 500]), false); // mode out of range
  assert.equal(modbus._emsBlockSane([0, 130, 95, 20, 500, 100, 500]), false); // percent over 100
  assert.equal(modbus._emsBlockSane(null), false);
});

test('a write-multiple frame carries address, count, byte count and values', () => {
  const pdu = modbus._buildWritePdu(0x10CC, [4]);
  assert.deepEqual([...pdu], [0x10, 0x10, 0xCC, 0x00, 0x01, 0x02, 0x00, 0x04]);

  const two = modbus._buildWritePdu(0x0134, [95, 30]);
  assert.deepEqual([...two], [0x10, 0x01, 0x34, 0x00, 0x02, 0x04, 0x00, 95, 0x00, 30]);
});

test('a read frame carries function code, address and quantity', () => {
  const pdu = modbus._buildPdu(0x04, 0x00B4, 1);
  assert.deepEqual([...pdu], [0x04, 0x00, 0xB4, 0x00, 0x01]);
});

test('a state of charge cannot jump further than the battery can move', () => {
  const fresh = new HoymilesModbus({ host: '127.0.0.1', port: 502, unitId: 1, log() {}, error() {} });
  const def = { maxJump: 5, maxRatePerMin: 1 };
  assert.equal(fresh._plausibleChange('soc', 37, def), true);   // nothing to compare with yet
  fresh._remember('soc', 37);
  assert.equal(fresh._plausibleChange('soc', 39, def), true);
  // The stick once answered 57 for a pack at 37 right after reconnecting.
  assert.equal(fresh._plausibleChange('soc', 57, def), false);
  // Fields that genuinely swing hard declare no limit and are never held back.
  assert.equal(fresh._plausibleChange('power', 8000, {}), true);
});
