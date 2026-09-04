import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readCredentials, queryBalance } from '../src/lib/balance.js';
import { QuotaService } from '../src/dshhome/quota.js';

const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('deepseek adapter parses balance_infos', async () => {
  const fetchImpl = async (url, opts) => {
    assert.equal(url, 'https://api.deepseek.com/user/balance');
    assert.equal(opts.headers.Authorization, 'Bearer sk-test');
    return jsonRes({ balance_infos: [{ currency: 'CNY', total_balance: '42.50' }] });
  };
  const r = await queryBalance({ provider: 'deepseek', key: 'sk-test' }, fetchImpl);
  assert.deepEqual(r, { provider: 'deepseek', remaining: 42.5, currency: 'CNY' });
});

test('kimi adapter parses available_balance', async () => {
  const fetchImpl = async () => jsonRes({ code: 0, data: { available_balance: 8.9 } });
  const r = await queryBalance({ provider: 'kimi', key: 'sk-test' }, fetchImpl);
  assert.deepEqual(r, { provider: 'kimi', remaining: 8.9, currency: 'CNY' });
});

test('queryBalance degrades errors instead of throwing', async () => {
  const boom = await queryBalance({ provider: 'deepseek', key: 'x' }, async () => { throw new Error('network down'); });
  assert.equal(boom.error, 'network down');
  const httpErr = await queryBalance({ provider: 'kimi', key: 'x' }, async () => jsonRes({}, 401));
  assert.match(httpErr.error, /HTTP 401/);
  const unknown = await queryBalance({ provider: 'macstudio_local', key: 'x' }, async () => { throw new Error('should not be called'); });
  assert.equal(unknown.error, 'no adapter');
  const noApi = await queryBalance({ provider: 'zai', key: 'x' });
  assert.equal(noApi.error, 'no public balance API');
});

test('readCredentials reads refs: block with values', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hwb-cred-'));
  writeFileSync(path.join(dir, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-secret-1\n  ZAI_API_KEY: zzz\n');
  const creds = readCredentials(dir);
  assert.deepEqual(creds, [
    { ref: 'DEEPSEEK_API_KEY', key: 'sk-secret-1' },
    { ref: 'ZAI_API_KEY', key: 'zzz' },
  ]);
  rmSync(dir, { recursive: true, force: true });
});

test('QuotaService: TTL cache, single-flight, keys never leak', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hwb-quota-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, '.credentials.yaml'), 'refs:\n  DEEPSEEK_API_KEY: sk-must-not-leak\n');

  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonRes({ balance_infos: [{ currency: 'CNY', total_balance: '100.00' }] });
  };
  const events = [];
  const store = {
    listHomes: () => [{
      homeId: 'h1',
      homePath: dir,
      providers: [{ ref: 'DEEPSEEK_API_KEY', provider: 'deepseek' }],
    }],
  };
  const svc = new QuotaService({ store, broadcast: (e, d) => events.push(e), fetchImpl, ttlMs: 60_000 });

  // 首屏：缓存空 → 立即返回空 + 后台触发刷新
  assert.deepEqual(svc.list(), []);
  await svc.refresh();
  assert.equal(calls, 1);

  const rows = svc.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].remaining, 100);
  assert.equal(rows[0].currency, 'CNY');
  assert.ok(!JSON.stringify(rows).includes('sk-must-not-leak'));

  // TTL 内不重复查询；强制 refresh 才再查
  await svc.refresh();
  assert.equal(calls, 2); // refresh 总是强制
  assert.ok(events.includes('quota:updated'));

  // 失败降级：fetch 全挂 → 行仍在，带 error
  const svcDown = new QuotaService({
    store,
    fetchImpl: async () => { throw new Error('offline'); },
    ttlMs: 60_000,
  });
  const down = await svcDown.refresh();
  assert.equal(down[0].provider, 'deepseek');
  assert.match(down[0].error, /offline/);
});
