import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initLogger, logger, levelVal, installCrashHandlers, defaultLogFile,
  getLogs, onLog, clearLogs,
} from '../src/lib/logger.js';

// 拦截全局 console，把 log/error 都收集到同一数组，供断言输出。
function captureConsole(fn) {
  const lines = [];
  const orig = { log: console.log, error: console.error };
  console.log = (l) => lines.push(String(l));
  console.error = (l) => lines.push(String(l));
  try { fn(); } finally { console.log = orig.log; console.error = orig.error; }
  return lines;
}

// each test resets logger to a known, quiet baseline.
function reset(overrides = {}) {
  initLogger({ level: 'info', file: false, color: false, silent: true, ...overrides });
}

test('logger: level filtering drops below-threshold messages', () => {
  reset({ level: 'warn', silent: false });
  const lines = captureConsole(() => {
    const l = logger('svc');
    l.debug('debug msg');
    l.info('info msg');
    l.warn('warn msg');
    l.error('err msg');
  });
  assert.equal(lines.some((s) => s.includes('debug msg')), false);
  assert.equal(lines.some((s) => s.includes('info msg')), false);
  assert.ok(lines.some((s) => s.includes('warn msg')));
  assert.ok(lines.some((s) => s.includes('err msg')));
});

test('logger: message carries scope tag and level', () => {
  reset({ level: 'info', silent: false });
  const lines = captureConsole(() => logger('launcher').info('started'));
  const s = lines.join('\n');
  assert.ok(s.includes('[launcher]'));
  assert.ok(s.includes('INFO'));
  assert.ok(s.includes('started'));
});

test('logger: error(message, err, ctx) prints stack + context fields', () => {
  reset({ level: 'error', silent: false });
  const lines = captureConsole(() => {
    logger('launcher').error('boom', new Error('kaboom'), { homeId: 'h1', port: 4310 });
  });
  const s = lines.join('\n');
  assert.ok(s.includes('boom'));
  assert.ok(s.includes('Error'));
  assert.ok(s.includes('kaboom'));
  assert.ok(s.includes('logger.test.js')); // stack frame source file
  assert.ok(s.includes('homeId=h1'));
  assert.ok(s.includes('port=4310'));
});

test('logger: context object with multiline stderr rendered as indented block', () => {
  reset({ level: 'error', silent: false });
  const lines = captureConsole(() => {
    logger('launcher').error('launch failed', { homeId: 'h1', stderr: 'line1\nline2' });
  });
  const s = lines.join('\n');
  assert.ok(s.includes('stderr='));
  assert.ok(s.includes('line1'));
  assert.ok(s.includes('line2'));
});

test('logger: silent suppresses console but still writes file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-log-'));
  const file = path.join(dir, 'hwb.log');
  try {
    reset({ level: 'info', file, silent: true });
    logger('svc').info('to file only');
    const lines = captureConsole(() => logger('svc').warn('warn still to file'));
    assert.equal(lines.length, 0, 'silent must yield no console output');
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.includes('to file only'));
    assert.ok(content.includes('warn still to file'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('logger: rotates the log file once it exceeds rotateBytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-log-'));
  const file = path.join(dir, 'hwb.log');
  try {
    reset({ level: 'debug', file, silent: true, rotateBytes: 200 });
    const l = logger('svc');
    const filler = 'x'.repeat(100);
    for (let i = 0; i < 40; i++) l.info(`${i}: ${filler}`);
    assert.ok(fs.existsSync(`${file}.1`), 'expected a .1 rotated backup');
    assert.ok(fs.existsSync(`${file}.2`), 'expected a .2 rotated backup');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('logger: installCrashHandlers registers + unregisters both handlers', () => {
  const handlers = {};
  const proc = {
    on: (n, f) => { handlers[n] = f; },
    off: (n) => { delete handlers[n]; },
    listenerCount: (n) => (handlers[n] ? 1 : 0),
    pid: 99,
    exit: () => {},
  };
  const cleanup = installCrashHandlers({ process: proc });
  assert.equal(typeof handlers.uncaughtException, 'function');
  assert.equal(typeof handlers.unhandledRejection, 'function');
  cleanup();
  assert.equal(handlers.uncaughtException, undefined);
  assert.equal(handlers.unhandledRejection, undefined);
});

test('logger: defaultLogFile resolves under ~/.hwb', () => {
  assert.ok(defaultLogFile().includes(`${path.sep}.hwb${path.sep}hwb.log`));
});

test('logger: levelVal maps human levels to numeric ranks', () => {
  assert.equal(levelVal('debug'), 1);
  assert.equal(levelVal('info'), 2);
  assert.equal(levelVal('error'), 4);
});

// —— 日志区域：内存环缓冲 + onLog 订阅 + 级别过滤 ——
test('logger: onLog receives each emitted entry', () => {
  reset({ level: 'debug', file: false, silent: false });
  const got = [];
  const unsub = onLog((e) => got.push(e));
  try {
    logger('svc').info('hello', { k: 'v' });
    logger('svc').warn('careful');
    assert.equal(got.length, 2, 'onLog should receive both entries');
    assert.equal(got[0].level, 'info');
    assert.equal(got[0].message, 'hello');
    assert.deepEqual(got[0].fields, { k: 'v' });
  } finally {
    unsub();
  }
  logger('svc').info('after unsub');
  assert.equal(got.length, 2, 'unsubscribed listener must not fire');
});

test('logger: getLogs returns ring entries and filters by level', () => {
  reset({ level: 'debug', file: false, silent: false });
  clearLogs();
  const l = logger('svc');
  l.debug('d1');
  l.info('i1');
  l.warn('w1', { homeId: 'h1' });
  l.error('e1', new Error('boom'));

  const all = getLogs({ limit: 100 });
  assert.ok(all.length >= 4);

  const fromWarn = getLogs({ level: 'warn', limit: 100 });
  assert.deepEqual(fromWarn.map((e) => e.level), ['warn', 'error']);

  const fromError = getLogs({ level: 'error', limit: 100 });
  assert.deepEqual(fromError.map((e) => e.level), ['error']);
  assert.ok(fromError[0].stack, 'error entry carries a stack trace');
});

test('logger: getLogs honors the limit cap', () => {
  reset({ level: 'debug', file: false, silent: false });
  clearLogs();
  const l = logger('svc');
  for (let i = 0; i < 10; i++) l.info(`msg ${i}`);
  const out = getLogs({ limit: 3 });
  assert.equal(out.length, 3);
  assert.equal(out[2].message, 'msg 9');
});

test('logger: initLogger seeds ring from the log file tail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-log-'));
  const file = path.join(dir, 'hwb.log');
  const body = [
    '[2026-09-05T10:00:00.000] INFO  [server] boot ok',
    '[2026-09-05T10:00:01.000] ERROR [server] launch failed',
    '  homeId=h1',
    '[2026-09-05T10:00:02.000] WARN  [monitor] degraded',
    '',
  ].join('\n');
  fs.writeFileSync(file, body);
  try {
    clearLogs();
    reset({ level: 'info', file, silent: true });
    const all = getLogs({ limit: 100 });
    assert.ok(all.some((e) => e.message.includes('boot ok')), 'seeded an info entry');
    const err = all.find((e) => e.level === 'error');
    assert.ok(err, 'seeded the error entry');
    assert.ok(err.message.includes('launch failed'));
    assert.ok(err.message.includes('homeId=h1'), 'continuation line merged into the entry');
    assert.ok(all.some((e) => e.level === 'warn'), 'seeded the warn entry');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
