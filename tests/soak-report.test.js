/**
 * The overnight report is what the reader actually sees, so its honesty is part
 * of the deliverable: the numbers must not appear without the caveat that
 * explains how to read them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportMarkdown, wireBytesFrom, tailLines } from '../scripts/soak/soak.mjs';

const rows = (n, okAll = true) => Array.from({ length: n }, (_, i) => ({
  round: i + 1,
  startedAt: `2026-09-14T0${i}:00:00.000Z`,
  finishedAt: `2026-09-14T0${i}:00:30.000Z`,
  probeOk: true,
  cold: { ok: okAll, ms: 3000, attemptsUsed: 1, phase: okAll ? 'done' : 'pre-exec', wire: { total: 9800 }, error: okAll ? '' : 'Connection closed by 10.8.0.21 port 22' },
  warm: { ok: okAll, ms: 1500, attemptsUsed: 1 },
}));

const stats = (over = {}) => ({
  probeOk: 2, coldOk: 2, warmOk: 2,
  coldP50: 2503, coldP90: 2849, coldMax: 2849,
  warmP50: 1833, warmP90: 2360, warmMax: 2360,
  wireP50: 9625, wireN: 2,
  attemptsCold: '2 first-try', attemptsWarm: '2 first-try',
  phases: {}, errors: [], ...over,
});

test('the report always carries the contention caveat', () => {
  // Without it, a success rate invites the reader to blame the link for failures
  // that two ssh consumers competing for MaxStartups can equally explain.
  const md = reportMarkdown('f.jsonl', rows(2), stats());
  assert.match(md, /hwb/);
  assert.match(md, /MaxStartups/);
  assert.match(md, /有竞争/);
});

test('the report states rounds, window and success rates', () => {
  const md = reportMarkdown('f.jsonl', rows(4), stats());
  assert.match(md, /共 \*\*4\*\* 轮/);
  assert.match(md, /probe 可达 \| 2\/4/);
  assert.match(md, /冷启动延迟 \| p50 2503/);
});

test('failure phases and distinct errors are surfaced when present', () => {
  const md = reportMarkdown('f.jsonl', rows(3, false), stats({
    coldOk: 0, phases: { 'pre-exec': 3 }, errors: ['Connection closed by 10.8.0.21 port 22'],
  }));
  assert.match(md, /失败阶段分布：`pre-exec`×3/);
  assert.match(md, /Connection closed by 10\.8\.0\.21/);
});

test('absent retry data is reported as absent, never as zero', () => {
  const md = reportMarkdown('f.jsonl', rows(2), stats({ attemptsCold: 'n/a (field absent in these rounds)' }));
  assert.match(md, /n\/a \(field absent in these rounds\)/);
});

test('failed rounds never contribute bytes to the statistics', () => {
  // A failed round records wire=0 (the shim spawned, transferred nothing).
  // Counting those zeroes would report the cost of a working call as 0 B.
  const healthy = { cold: { ok: true, wire: { total: 9833 } } };
  const failed = { cold: { ok: false, wire: { total: 0 } } };
  assert.deepEqual(wireBytesFrom([healthy]), [9833]);
  assert.deepEqual(wireBytesFrom([healthy, failed]), [9833], 'one failure must not halve the picture');
  assert.deepEqual(wireBytesFrom([failed, failed]), [], 'no successful round means no byte claim at all');
});

test('a successful round with no measurement is skipped, not counted as zero', () => {
  const noMeasure = { cold: { ok: true, wire: null } };
  assert.deepEqual(wireBytesFrom([noMeasure]), []);
});

// --- what the morning report shows as the "error" --------------------------
// The whole point of the soak is to learn HOW the link fails, so the recorded
// error must be the cause. Scraping raw stderr captured the harness's own retry
// chatter and (for a failed probe) a JSON fragment instead.

test('retry chatter and ssh debug noise are stripped from the recorded error', () => {
  const captured = [
    'debug1: Reading configuration data /Users/ciao/.ssh/config',
    'dsh21: attempt 1 failed before the remote task started (pre-exec); reconnecting in 2s',
    'dsh21: attempt 2 failed before the remote task started (pre-exec); reconnecting in 4s',
    'kex_exchange_identification: Connection closed by remote host',
  ].join('\n');
  assert.equal(tailLines(captured), 'kex_exchange_identification: Connection closed by remote host');
});

test('the last lines are kept when there is nothing to strip', () => {
  assert.equal(tailLines('a\nb\nc\nd'), 'b | c | d');
  assert.equal(tailLines(''), '');
  assert.equal(tailLines(undefined), '');
});

test('the report tolerates rows with no version marker', () => {
  // The overnight file was produced by a harness that had the v2 FIELDS but not
  // yet the `v` marker. Absence of the marker must not be read as "no retries".
  const v1ish = rows(2).map(({ round, startedAt, finishedAt, probeOk, cold, warm }) =>
    ({ round, startedAt, finishedAt, probeOk, cold, warm }));
  for (const r of v1ish) delete r.cold.attemptsUsed;
  const md = reportMarkdown('f.jsonl', v1ish, stats({ attemptsCold: 'n/a (field absent in these rounds)' }));
  assert.match(md, /n\/a \(field absent in these rounds\)/);
  assert.match(md, /hwb/, 'the caveat must survive regardless of record shape');
});
