import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTERVENTION_KINDS, INTERVENTION_LABELS, interventionRank, normalizeIntervention,
  deriveProjectionIntervention, mergeIntervention, strongestIntervention, interventionOfSession,
} from '../src/lib/intervention.js';
import { deriveSessionStatus } from '../src/lib/status.js';
import { validateProjcacheRecord } from '../src/lib/schema.js';

const questionBatch = (text = '要继续吗？') => ({
  questions: {
    active: [{ callId: 'call-1', state: 'open', questions: [{ id: 'q1', question: text }] }],
    settled: [],
  },
});

test('normalizeIntervention：kind 白名单 + label 本地派生（不信任上游文案）', () => {
  assert.deepEqual(INTERVENTION_KINDS, ['approval', 'plan-review', 'question']);
  for (const kind of INTERVENTION_KINDS) {
    const v = normalizeIntervention({ kind, label: '"><img src=x>' });
    assert.equal(v.kind, kind);
    assert.equal(v.label, INTERVENTION_LABELS[kind]);
    assert.ok(v.label.length > 0);
  }
  // 未知/缺失 kind 一律不认 —— 否则 UI 会画出一个没有文案的介入 chip。
  for (const bad of [null, undefined, {}, [], 'approval', { kind: 'done' }, { kind: '__proto__' }, { kind: 1 }]) {
    assert.equal(normalizeIntervention(bad), null, `${JSON.stringify(bad)} 应归一为 null`);
  }
});

test('normalizeIntervention：文本截断、剥 NUL、tool 只属于审批、count 夹紧', () => {
  const long = 'x'.repeat(500);
  const v = normalizeIntervention({ kind: 'approval', tool: `bad\u0000tool`, reason: long, count: 999, since: '2026-10-27T06:00:00Z' });
  assert.equal(v.tool, 'badtool');
  assert.equal(v.reason.length, 161);          // 160 + 省略号
  assert.ok(v.reason.endsWith('…'));
  assert.equal(v.count, 50);
  assert.equal(v.since, '2026-10-27T06:00:00.000Z');
  // 非审批来源的 tool 没有意义：不能让 UI 显示「等待回答 · bash」这种误导信息。
  assert.equal(normalizeIntervention({ kind: 'question', tool: 'bash' }).tool, null);
  // 非字符串 / 空白 / 非法时间 / 非法计数都降级，而不是抛错或落一个坏值。
  for (const bad of [{ tool: {} }, { reason: [] }, { reason: '   ' }, { since: 'not-a-date' }, { count: 0 }]) {
    const n = normalizeIntervention({ kind: 'question', ...bad });
    assert.equal(n.tool, null);
    assert.equal(n.reason, null);
    assert.equal(n.since, null);
    assert.equal(n.count, 1);
  }
  // source 只认 live，其它一律 projection（保守：可被 live 覆盖）。
  assert.equal(normalizeIntervention({ kind: 'question', source: 'live' }).source, 'live');
  assert.equal(normalizeIntervention({ kind: 'question', source: 'CACHE' }).source, 'projection');
});

test('deriveProjectionIntervention：只认确实带问题的 active 批次，坏结构不产生假提示', () => {
  assert.equal(deriveProjectionIntervention({}), null);
  assert.equal(deriveProjectionIntervention({ userQuestions: null }), null);
  for (const bad of [
    [],
    {},
    { questions: null },
    { questions: { active: [] } },
    { questions: { active: [{ callId: 'c1' }] } },                    // 半截快照：没有 questions
    { questions: { active: [{ callId: 'c1', questions: [] }] } },     // 空提问批次
    { questions: { active: ['x', 1, null] } },                        // 脏条目
  ]) {
    assert.equal(deriveProjectionIntervention({ userQuestions: bad }), null, JSON.stringify(bad));
  }
  const v = deriveProjectionIntervention({ userQuestions: questionBatch(' 要不要合并？\u0000 ') });
  assert.equal(v.kind, 'question');
  assert.equal(v.source, 'projection');
  assert.equal(v.reason, '要不要合并？');
  assert.equal(v.count, 1);
  // 多批次：count 报批次数（UI 只用来做 badge 文案）。
  const two = deriveProjectionIntervention({
    userQuestions: { questions: { active: [
      { callId: 'a', questions: [{ id: 'q', question: 'A' }] },
      { callId: 'b', questions: [{ id: 'q', question: 'B' }] },
    ] } },
  });
  assert.equal(two.count, 2);
  assert.equal(two.reason, 'A');
});

test('mergeIntervention：审批压过其它、同 kind 实时压过投影、字段只补空、since 取更早', () => {
  assert.equal(interventionRank('approval'), 3);
  assert.equal(interventionRank('plan-review'), 2);
  assert.equal(interventionRank('question'), 1);
  assert.equal(interventionRank('none'), 0);

  const q = { kind: 'question', source: 'projection', reason: '问题', since: '2026-10-27T05:00:00Z' };
  const review = { kind: 'plan-review', source: 'live', reason: '计划', since: '2026-10-27T06:00:00Z' };
  const approve = { kind: 'approval', source: 'live', tool: 'bash', since: '2026-10-27T07:00:00Z' };

  assert.equal(mergeIntervention(q, review).kind, 'plan-review');
  assert.equal(mergeIntervention(review, approve).kind, 'approval');
  // 顺序无关：交换入参结论一样。
  assert.equal(mergeIntervention(approve, review).kind, 'approval');

  // 同 kind：live 赢，但投影知道的文本保留（live 没带 reason 时补空）。
  const live = normalizeIntervention({ kind: 'question', source: 'live', since: '2026-10-27T06:00:00Z' });
  const merged = mergeIntervention(normalizeIntervention(q), live);
  assert.equal(merged.source, 'live');
  assert.equal(merged.reason, '问题');
  assert.equal(merged.since, '2026-10-27T05:00:00.000Z');            // 最早那次
  assert.equal(merged.count, 1);

  // null 安全：任何一侧缺失都能直接当结果用。
  assert.deepEqual(mergeIntervention(null, q), normalizeIntervention(q));
  assert.equal(mergeIntervention(null, null), null);
});

test('strongestIntervention / interventionOfSession：两处落点合并取强者', () => {
  const projected = { kind: 'question', source: 'projection', reason: '投影问题' };
  const live = { kind: 'approval', source: 'live', tool: 'bash' };
  assert.equal(strongestIntervention([projected, live]).kind, 'approval');
  assert.equal(strongestIntervention([]), null);
  assert.equal(strongestIntervention(null), null);

  assert.equal(interventionOfSession({ status: { intervention: projected } }).kind, 'question');
  assert.equal(interventionOfSession({ intervention: live }).kind, 'approval');
  assert.equal(interventionOfSession({ status: { intervention: projected }, intervention: live }).kind, 'approval');
  assert.equal(interventionOfSession({}), null);
  assert.equal(interventionOfSession(null), null);
});

test('投影 → 状态：deriveSessionStatus 输出 intervention（等待回答）并保持三态推导不变', () => {
  const idle = deriveSessionStatus({ userQuestions: questionBatch('需要你选一个方案') });
  assert.equal(idle.kind, 'idle');                       // 等回答不是「运行中」
  assert.equal(idle.intervention.kind, 'question');
  assert.equal(idle.intervention.reason, '需要你选一个方案');
  // 没有提问时**不写这个键**（不是 null），UI 据此不画 chip。
  assert.equal(deriveSessionStatus({}).intervention, undefined);
  assert.equal('intervention' in deriveSessionStatus({}), false);

  // 运行中的会话同时有未回答提问：两个信号互不干扰。
  const running = deriveSessionStatus({
    sessionStats: { openStep: 2 },
    lastActivity: new Date().toISOString(),
    userQuestions: questionBatch(),
  });
  assert.equal(running.kind, 'running');
  assert.equal(running.intervention.kind, 'question');
});

test('projcache 记录 → 会话 meta：userQuestions 透传为 intervention（离线也能标等待回答）', () => {
  const doc = {
    version: 7,
    record: {
      identity: { createdAt: Date.now(), cwd: '/tmp/x' },
      rows: {
        sessionListMetadata: { ver: 1, seq: 2, val: { lastPromptAt: Date.now() } },
        userQuestions: { ver: 2, seq: 3, val: questionBatch('离线也要能看出来') },
      },
    },
  };
  const v = validateProjcacheRecord(doc, 'session-abc.json');
  assert.equal(v.ok, true);
  assert.equal(v.session.status.kind, 'idle');
  assert.equal(v.session.status.intervention.kind, 'question');
  assert.equal(v.session.status.intervention.reason, '离线也要能看出来');

  // 没有该投影（旧版 dsh / 已答完）→ 不产生介入。
  const plain = validateProjcacheRecord({ version: 7, record: { identity: { createdAt: Date.now() }, rows: {} } }, 'session-def.json');
  assert.equal(plain.ok, true);
  assert.equal(plain.session.status.intervention, undefined);
});

test('实时通道：userQuestions 投影同样带出 intervention（与文件侧同一套推导）', async () => {
  const { LiveStatusReader } = await import('../src/dshhome/live-status.js');
  const saved = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    type: 'server-response',
    result: { ok: true, value: { items: [{
      sessionId: 's1', cwd: '/r', running: false,
      projections: { values: { userQuestions: questionBatch('实时提问') } },
    }] } },
  });
  try {
    const rows = await new LiveStatusReader().read('http://127.0.0.1:1/', {});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status.kind, 'idle');
    assert.equal(rows[0].status.intervention.kind, 'question');
    assert.equal(rows[0].status.intervention.reason, '实时提问');
  } finally {
    globalThis.fetch = saved;
  }
});

test('实时行：投影被上报但为空 → 显式 intervention:null；没上报 → 不带这个键（语义可区分）', async () => {
  const { LiveStatusReader } = await import('../src/dshhome/live-status.js');
  const saved = globalThis.fetch;
  const rowsFor = async (values) => {
    globalThis.fetch = async () => Response.json({
      type: 'server-response',
      result: { ok: true, value: { items: [{ sessionId: 's1', cwd: '/r', running: true, projections: { values } }] } },
    });
    return new LiveStatusReader().read('http://127.0.0.1:1/', {});
  };
  try {
    const empty = (await rowsFor({ userQuestions: { questions: { active: [], settled: [] } } }))[0];
    assert.equal(Object.hasOwn(empty.status, 'intervention'), true, '上报了投影（即使为空）就要显式给 null');
    assert.equal(empty.status.intervention, null);
    const missing = (await rowsFor({}));
    assert.equal(Object.hasOwn(missing[0].status, 'intervention'), false, '没上报投影时不能假装「确认没有在等」');
  } finally {
    globalThis.fetch = saved;
  }
});

test('mergeLiveStatus：实时没报 intervention 时保留文件侧的等待回答，实时显式 null 时才清掉', async () => {
  const { mergeLiveStatus } = await import('../src/dshhome/reader.js');
  const projected = { kind: 'question', label: '等待回答', source: 'projection', since: null, tool: null, reason: '继续吗？', count: 1 };
  const rows = () => [{
    type: 'session', homeId: 'h1', sessionId: 's1', status: JSON.stringify({ kind: 'idle', label: '空闲', intervention: projected }),
  }];
  const live = (status) => [{ sessionId: 's1', status, lastActivity: '2026-10-27T06:00:00Z' }];

  // 旧版 dsh：实时 status 不带 intervention 键 → 文件侧标记必须留下（否则每 3s 被清一次）。
  const preserved = mergeLiveStatus(rows(), live({ kind: 'running', label: '运行中' }), { homeId: 'h1', generatedAt: 'x' });
  assert.equal(JSON.parse(preserved[0].status).intervention.kind, 'question');
  assert.equal(JSON.parse(preserved[0].status).kind, 'running');

  // 新版 dsh 明确报「没有在等」（显式 null）→ 清掉。
  const cleared = mergeLiveStatus(rows(), live({ kind: 'running', label: '运行中', intervention: null }), { homeId: 'h1', generatedAt: 'x' });
  assert.equal(JSON.parse(cleared[0].status).intervention, null);

  // 坏 JSON 基线：按「没有基线」处理，直接采用实时 status，不抛错。
  const broken = mergeLiveStatus([{ type: 'session', homeId: 'h1', sessionId: 's1', status: '{not json' }], live({ kind: 'idle' }), { homeId: 'h1', generatedAt: 'x' });
  assert.deepEqual(JSON.parse(broken[0].status), { kind: 'idle' });
});
