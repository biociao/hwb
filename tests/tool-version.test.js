import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TOOL_VERSION_TTL_MS,
  clearToolVersionCache,
  resolveToolVersion,
} from '../src/lib/tool-version.js';

const NOW = Date.parse('2026-10-25T04:00:00.000Z');

function mkHome(t, prefix = 'hwb-tool-version-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function workbuddyHome(overrides = {}) {
  clearToolVersionCache();
  return { harness: 'workbuddy', ...overrides };
}

test('WorkBuddy：读 startup-seed-version.json 的 appVersion', (t) => {
  const home = mkHome(t);
  writeJson(path.join(home, 'startup-seed-version.json'), { appVersion: '5.8.3' });
  assert.deepEqual(resolveToolVersion(workbuddyHome({ homePath: home }), { now: NOW }), {
    label: 'WorkBuddy',
    version: '5.8.3',
  });
});

test('WorkBuddy：回退 app/renderer-version.json 的 version', (t) => {
  const home = mkHome(t);
  writeJson(path.join(home, 'app', 'renderer-version.json'), { version: '5.8.3' });
  assert.deepEqual(resolveToolVersion(workbuddyHome({ homePath: home }), { now: NOW }), {
    label: 'WorkBuddy',
    version: '5.8.3',
  });
});

test('WorkBuddy：seed 缺失时用 renderer-version，seed 合法时优先', (t) => {
  const home = mkHome(t);
  writeJson(path.join(home, 'startup-seed-version.json'), { appVersion: '5.9.0' });
  writeJson(path.join(home, 'app', 'renderer-version.json'), { version: '5.8.3' });
  assert.deepEqual(resolveToolVersion(workbuddyHome({ homePath: home }), { now: NOW }), {
    label: 'WorkBuddy',
    version: '5.9.0',
  });
});

test('Codex：读 packages/standalone/current 软链并剥掉平台后缀', (t) => {
  const home = mkHome(t, 'hwb-tool-version-codex-');
  const release = path.join(home, 'packages', 'standalone', 'releases', '0.153.4-aarch64-apple-darwin');
  fs.mkdirSync(release, { recursive: true });
  try {
    fs.symlinkSync(release, path.join(home, 'packages', 'standalone', 'current'), 'dir');
  } catch (error) {
    t.skip(`当前平台不支持创建目录软链：${error.message}`);
    return;
  }
  assert.deepEqual(resolveToolVersion({ harness: 'codex', homePath: home }, { now: NOW }), {
    label: 'Codex',
    version: '0.153.4',
  });
});

test('Codex：软链目标带预发布后缀（0.153.4-rc.1-aarch64-…）也能取干净版本', (t) => {
  const home = mkHome(t, 'hwb-tool-version-codex-');
  const release = path.join(home, 'packages', 'standalone', 'releases', '0.153.4-rc.1-aarch64-apple-darwin');
  fs.mkdirSync(release, { recursive: true });
  try {
    fs.symlinkSync(release, path.join(home, 'packages', 'standalone', 'current'), 'dir');
  } catch (error) {
    t.skip(`当前平台不支持创建目录软链：${error.message}`);
    return;
  }
  assert.equal(resolveToolVersion({ harness: 'codex', homePath: home }, { now: NOW }).version, '0.153.4-rc.1');
});

test('Codex：无软链时回退 version.json 的 latest_version', (t) => {
  const home = mkHome(t, 'hwb-tool-version-codex-');
  writeJson(path.join(home, 'version.json'), { latest_version: '0.153.4', last_checked_at: '2026-09-06T10:52:56Z' });
  assert.deepEqual(resolveToolVersion({ harness: 'codex', homePath: home }, { now: NOW }), {
    label: 'Codex',
    version: '0.153.4',
  });
});

test('Codex：软链存在时优先于 version.json', (t) => {
  const home = mkHome(t, 'hwb-tool-version-codex-');
  writeJson(path.join(home, 'version.json'), { latest_version: '0.100.0' });
  const release = path.join(home, 'packages', 'standalone', 'releases', '0.153.4-x86_64-apple-darwin');
  fs.mkdirSync(release, { recursive: true });
  try {
    fs.symlinkSync(release, path.join(home, 'packages', 'standalone', 'current'), 'dir');
  } catch (error) {
    t.skip(`当前平台不支持创建目录软链：${error.message}`);
    return;
  }
  assert.equal(resolveToolVersion({ harness: 'codex', homePath: home }, { now: NOW }).version, '0.153.4');
});

test('版本号白名单：只显示干净的 x.y.z[-prerelease]，其它一律当未知', (t) => {
  const cases = [
    ['5.8.3', '5.8.3'],
    ['5.8.3-rc.1', '5.8.3-rc.1'],
    ['0.2.0-alpha.2', '0.2.0-alpha.2'],
    ['5.8', null],
    ['v5.8.3', null],
    ['5.8.3 extra', null],
    ['5.8.3/../x', null],
    ['not-a-version', null],
    ['', null],
    ['   ', null],
    ['5.8.3.1', null],
  ];
  for (const [raw, expected] of cases) {
    const home = mkHome(t, 'hwb-tool-version-whitelist-');
    writeJson(path.join(home, 'startup-seed-version.json'), { appVersion: raw });
    const resolved = resolveToolVersion({ harness: 'workbuddy', homePath: home }, { now: NOW });
    assert.equal(resolved?.version ?? null, expected, `appVersion=${JSON.stringify(raw)}`);
  }
});

test('文件缺失 / 非本地工具（dsh）/ 空 home → null（不画占位符）', (t) => {
  const empty = mkHome(t);
  assert.equal(resolveToolVersion({ harness: 'workbuddy', homePath: empty }, { now: NOW }), null);
  assert.equal(resolveToolVersion({ harness: 'codex', homePath: empty }, { now: NOW }), null);
  assert.equal(resolveToolVersion({ harness: 'dsh', homePath: empty }, { now: NOW }), null);
  assert.equal(resolveToolVersion({}, { now: NOW }), null);
  assert.equal(resolveToolVersion(null, { now: NOW }), null);
});

test('显式 harness 优先于文件推断：dsh home 里即使有版本文件也返回 null', (t) => {
  const home = mkHome(t);
  writeJson(path.join(home, 'startup-seed-version.json'), { appVersion: '5.8.3' });
  assert.equal(resolveToolVersion({ harness: 'dsh', homePath: home }, { now: NOW }), null);
});

test('只给路径（字符串）时按哨兵文件推断 harness', (t) => {
  const wb = mkHome(t);
  writeJson(path.join(wb, 'startup-seed-version.json'), { appVersion: '5.8.3' });
  assert.deepEqual(resolveToolVersion(wb, { now: NOW }), { label: 'WorkBuddy', version: '5.8.3' });

  const codex = mkHome(t, 'hwb-tool-version-codex-');
  writeJson(path.join(codex, 'version.json'), { latest_version: '0.153.4' });
  assert.deepEqual(resolveToolVersion(codex, { now: NOW }), { label: 'Codex', version: '0.153.4' });
});

test('30 分钟缓存：TTL 内沿用旧值，过期后重读文件', (t) => {
  clearToolVersionCache();
  const home = mkHome(t);
  const seed = path.join(home, 'startup-seed-version.json');
  writeJson(seed, { appVersion: '5.8.3' });
  const args = { harness: 'workbuddy', homePath: home };

  assert.equal(resolveToolVersion(args, { now: NOW }).version, '5.8.3');
  writeJson(seed, { appVersion: '5.9.0' });

  // TTL 内：仍是缓存值（不会为每张卡片读一次文件）
  assert.equal(resolveToolVersion(args, { now: NOW + 1000 }).version, '5.8.3');
  assert.equal(resolveToolVersion(args, { now: NOW + TOOL_VERSION_TTL_MS - 1 }).version, '5.8.3');
  // 过期：重新读取
  assert.equal(resolveToolVersion(args, { now: NOW + TOOL_VERSION_TTL_MS + 1 }).version, '5.9.0');
});

test('读不到时按更短退避重试（用户刚装好不必等半小时）', (t) => {
  clearToolVersionCache();
  const home = mkHome(t);
  const seed = path.join(home, 'startup-seed-version.json');
  const args = { harness: 'workbuddy', homePath: home };

  assert.equal(resolveToolVersion(args, { now: NOW }), null); // 首次读不到
  writeJson(seed, { appVersion: '5.8.3' });
  // 退避窗口内仍按未知处理
  assert.equal(resolveToolVersion(args, { now: NOW + 1000 }), null);
  // 10 分钟后（> 2 分钟退避、< 30 分钟 TTL）重试命中
  assert.deepEqual(resolveToolVersion(args, { now: NOW + 10 * 60_000 }), { label: 'WorkBuddy', version: '5.8.3' });
});

test('缓存按 home 路径隔离；clearToolVersionCache 立即失效', (t) => {
  clearToolVersionCache();
  const a = mkHome(t);
  const b = mkHome(t);
  writeJson(path.join(a, 'startup-seed-version.json'), { appVersion: '5.8.3' });
  writeJson(path.join(b, 'startup-seed-version.json'), { appVersion: '5.9.0' });

  assert.equal(resolveToolVersion({ harness: 'workbuddy', homePath: a }, { now: NOW }).version, '5.8.3');
  assert.equal(resolveToolVersion({ harness: 'workbuddy', homePath: b }, { now: NOW }).version, '5.9.0');

  writeJson(path.join(a, 'startup-seed-version.json'), { appVersion: '6.0.0' });
  clearToolVersionCache();
  assert.equal(resolveToolVersion({ harness: 'workbuddy', homePath: a }, { now: NOW }).version, '6.0.0');
});
