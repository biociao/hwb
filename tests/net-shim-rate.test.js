/**
 * Rate-unit tests for the net-shim instrument.
 *
 * Every "it works at N KB/s" claim depends on this conversion, and getting it
 * wrong fails SILENTLY: the limiter paces to whatever the number means, so a
 * mislabelled unit yields a plausible run that tested a different link.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateToBytesPerSec } from '../scripts/soak/net-shim.mjs';

test('no rate means unlimited', () => {
  assert.equal(rateToBytesPerSec({}), 0);
  assert.equal(rateToBytesPerSec({ kbps: 0, kbyte: 0 }), 0);
});

test('kbps is KILOBITS per second', () => {
  assert.equal(rateToBytesPerSec({ kbps: 8 }), 1000);
  assert.equal(rateToBytesPerSec({ kbps: 32 }), 4000);
});

test('kbyte is KILOBYTES per second', () => {
  assert.equal(rateToBytesPerSec({ kbyte: 8 }), 8192);
  assert.equal(rateToBytesPerSec({ kbyte: 4 }), 4096);
});

test('the two units differ by ~8.2x, and mixing them up is the whole point', () => {
  // The bug this guards: the docs said KB/s for a flag the code read as kbps,
  // so "4 KB/s" silently meant 0.5 KB/s.
  //
  // Not exactly 8x: a kilobit is 1000 bits while a kilobyte is 1024 bytes, so
  // the true ratio is 1024/125 = 8.192. Stating it precisely matters -- sloppy
  // unit reasoning is what produced the original 8x mislabel.
  const kbpsToBytes = 1000 / 8;   // 125 B/s per kbps
  const kbyteToBytes = 1024;      // 1024 B/s per KB/s
  assert.equal(rateToBytesPerSec({ kbps: 1 }), kbpsToBytes);
  assert.equal(rateToBytesPerSec({ kbyte: 1 }), kbyteToBytes);
  assert.equal(kbyteToBytes / kbpsToBytes, 8.192);
  assert.notEqual(rateToBytesPerSec({ kbps: 4 }), rateToBytesPerSec({ kbyte: 4 }));
  // The mislabel shifted every tested speed by that factor.
  assert.equal(rateToBytesPerSec({ kbps: 4 }), 500);
});

test('kbyte wins when both are supplied', () => {
  assert.equal(rateToBytesPerSec({ kbps: 8, kbyte: 4 }), 4096);
});
