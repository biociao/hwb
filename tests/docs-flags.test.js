/**
 * The reproduction index tells the reader which commands re-derive each number.
 * A documented flag that does not exist turns "reproducible" into "annoying", so
 * the index is checked against the tools' own --help output.
 *
 * Same spirit as tests/docs-consistency.test.js: make the self-checkable part of
 * the documentation a test, instead of a number nobody re-derives.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DOC = path.join(root, 'docs', 'dgx21-lowbandwidth-channel.md');

/** Flags that belong to other programs, not to the scripts under test. */
const EXTERNAL = new Set(['--no-mux']); // (placeholder; keep empty unless needed)

function helpFlags(argv) {
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8' });
  return (r.stdout ?? '') + (r.stderr ?? '');
}

function ownFlags() {
  const text = [
    helpFlags([path.join(root, 'scripts', 'dsh21.mjs'), '--help']),
    helpFlags([path.join(root, 'scripts', 'soak', 'net-shim.mjs'), '--help']),
    helpFlags([path.join(root, 'scripts', 'soak', 'soak.mjs'), '--help']),
    helpFlags([path.join(root, 'scripts', 'soak', 'nodownload-check.mjs'), '--help']),
    helpFlags([path.join(root, 'scripts', 'soak', 'bundle-weight.mjs'), '--help']),
  ].join('\n');
  return new Set(text.match(/--[a-z][a-z0-9-]+/g) ?? []);
}

/** The reproduction index, i.e. everything between sections 8 and 9. */
function indexSection() {
  const doc = readFileSync(DOC, 'utf8');
  const start = doc.indexOf('## 8. 怎么复现本文的每个数字');
  const end = doc.indexOf('## 9.');
  assert.ok(start !== -1 && end > start, 'reproduction index section not found');
  return doc.slice(start, end);
}

test('every flag in the reproduction index is advertised by its own tool', () => {
  const known = ownFlags();
  assert.ok(known.size > 10, 'expected the tools to document their flags');
  const referenced = [...new Set(indexSection().match(/--[a-z][a-z0-9-]+/g) ?? [])];
  assert.ok(referenced.length > 10, 'expected the index to reference flags');
  const unknown = referenced.filter((f) => !known.has(f) && !EXTERNAL.has(f));
  assert.deepEqual(unknown, [], `documented but not implemented: ${unknown.join(', ')}`);
});

test('every tool answers --help instead of doing work', () => {
  // net-shim originally had no --help at all, so a reader following the index
  // could not discover its flags.
  for (const argv of [
    ['scripts', 'dsh21.mjs'],
    ['scripts', 'soak', 'net-shim.mjs'],
    ['scripts', 'soak', 'soak.mjs'],
    ['scripts', 'soak', 'nodownload-check.mjs'],
    ['scripts', 'soak', 'bundle-weight.mjs'],
  ]) {
    const r = spawnSync(process.execPath, [path.join(root, ...argv), '--help'], { encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, `${argv.at(-1)} --help should exit 0`);
    assert.match(r.stdout, /Usage|usage|net-shim|soak|dsh21|bundle-weight|nodownload/, `${argv.at(-1)} --help should print usage`);
  }
});

test('the rate-unit warning is present, because getting it wrong is silent', () => {
  const known = ownFlags();
  assert.ok(known.has('--rate-kbyte') && known.has('--rate-kbps'),
    'both rate units must stay documented; --rate-kbps alone was 8x ambiguous');
});
