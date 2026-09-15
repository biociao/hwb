/**
 * The "nothing was downloaded" claim is only worth making if a violation would be
 * caught. These pin the two decisive signals: a cache directory appearing, and an
 * existing one being written to.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diff, CENSUS } from '../scripts/soak/nodownload-check.mjs';

const base = () => ({
  host: 'x',
  paths: { '/p/pnpm': { state: 'present', mtime: '100', kb: '10' } },
  scalars: { dsh_version: '0.1.1-rc.2' },
});

test('an untouched remote reports no changes', () => {
  assert.deepEqual(diff(base(), base()), []);
});

test('a location present only in the new snapshot is reported', () => {
  const now = base();
  now.paths['/p/newstore'] = { state: 'present', mtime: '500', kb: '99' };
  const c = diff(base(), now);
  assert.equal(c.length, 1);
  assert.match(c[0], /not in the baseline/);
});

test('a location that vanished from the census is reported', () => {
  const now = base();
  delete now.paths['/p/pnpm'];
  const c = diff(base(), now);
  assert.equal(c.length, 1);
  assert.match(c[0], /missing from the new snapshot/);
});

test('an absent cache appearing is the decisive violation', () => {
  const b = base();
  b.paths['/p/npmcache'] = { state: 'absent', mtime: 'NA', kb: 'NA' };
  const now = base();
  now.paths['/p/npmcache'] = { state: 'present', mtime: '999', kb: '544108' };
  const c = diff(b, now);
  assert.equal(c.length, 1);
  assert.match(c[0], /APPEARED/);
});

test('a store whose mtime moved was written to', () => {
  const now = base();
  now.paths['/p/pnpm'].mtime = '200';
  const c = diff(base(), now);
  assert.equal(c.length, 1);
  assert.match(c[0], /mtime changed 100 -> 200/);
});

test('a changed dsh version is surfaced', () => {
  const now = base();
  now.scalars.dsh_version = '0.1.2';
  assert.match(diff(base(), now)[0], /dsh_version: 0\.1\.1-rc\.2 -> 0\.1\.2/);
});

test('whole-disk usage is NOT part of the census', () => {
  // dsh writes sessions as it works, so disk usage always moves; recording it
  // would make every comparison report CHANGED and prove nothing.
  assert.equal(/disk_used|df -k/.test(CENSUS), false);
});
