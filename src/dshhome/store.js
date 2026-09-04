import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { homeIdOf } from '../lib/read-home.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS homes (
  homeId TEXT PRIMARY KEY,
  homePath TEXT NOT NULL,
  alias TEXT,
  hostType TEXT CHECK(hostType IN ('local','remote')) DEFAULT 'local',
  status TEXT DEFAULT 'unknown',
  lastIndexedAt TEXT,
  degraded TEXT DEFAULT '[]',
  sortIndex INTEGER,
  host TEXT,
  remotePort INTEGER,
  remoteHome TEXT,
  remoteCmd TEXT,
  remoteLog TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  homeId TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  workspaceId TEXT,
  workspaceTitle TEXT,
  project TEXT,
  title TEXT,
  tokenUsage TEXT,
  contextPressure TEXT,
  status TEXT,
  lastActivity TEXT,
  generatedAt TEXT,
  UNIQUE(homeId, sessionId)
);
CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  homeId TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  title TEXT,
  path TEXT,
  project TEXT,
  archived INTEGER DEFAULT 0,
  sessionCount INTEGER DEFAULT 0,
  UNIQUE(homeId, workspaceId)
);
CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  homeId TEXT NOT NULL,
  ref TEXT NOT NULL,
  provider TEXT NOT NULL,
  UNIQUE(homeId, ref)
);
CREATE TABLE IF NOT EXISTS model_tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  homeId TEXT NOT NULL,
  tierId TEXT NOT NULL,
  active INTEGER DEFAULT 0,
  provider TEXT,
  model TEXT,
  UNIQUE(homeId, tierId)
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(lastActivity DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_home ON sessions(homeId);
`;

const int = (v, dflt) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : dflt;
};

// 依据统计周期自动选择分桶粒度：短周期更细、长周期更粗，使柱状图柱数保持在合理范围。
// hours → 每桶毫秒。24h=30分钟(48柱) / 3d=1小时(72柱) / 7d=3小时(56柱) / 14d=6小时(56柱) / 30d=12小时(60柱)。
function bucketStepMs(hours) {
  if (hours <= 24) return 30 * 60_000;       // 30 分钟
  if (hours <= 72) return 60 * 60_000;       // 1 小时
  if (hours <= 168) return 3 * 60 * 60_000;  // 3 小时
  if (hours <= 336) return 6 * 60 * 60_000;  // 6 小时
  return 12 * 60 * 60_000;                   // 12 小时
}

export class IndexStore {
  constructor(dbPath = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.migrate();
  }

  migrate() {
    const sess = this.db.prepare("SELECT name FROM pragma_table_info('sessions')").all().map((c) => c.name);
    if (!sess.includes('title')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN title TEXT');
    }
    if (!sess.includes('status')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN status TEXT');
    }
    const homes = this.db.prepare("SELECT name FROM pragma_table_info('homes')").all().map((c) => c.name);
    if (!homes.includes('sortIndex')) {
      this.db.exec('ALTER TABLE homes ADD COLUMN sortIndex INTEGER');
    }
    if (!homes.includes('host')) {
      this.db.exec('ALTER TABLE homes ADD COLUMN host TEXT');
    }
    if (!homes.includes('remotePort')) {
      this.db.exec('ALTER TABLE homes ADD COLUMN remotePort INTEGER');
    }
    if (!homes.includes('remoteHome')) {
      this.db.exec('ALTER TABLE homes ADD COLUMN remoteHome TEXT');
    }
    if (!homes.includes('remoteCmd')) {
      this.db.exec('ALTER TABLE homes ADD COLUMN remoteCmd TEXT');
    }
    if (!homes.includes('remoteLog')) {
      this.db.exec('ALTER TABLE homes ADD COLUMN remoteLog TEXT');
    }
  }

  close() {
    this.db.close();
  }

  registerHome({ homePath, alias = null, hostType = 'local', host = null, remotePort = null, remoteHome = null, remoteCmd = null, remoteLog = null }) {
    const homeId = homeIdOf(homePath);
    // 新 home 排在末尾；已存在（冲突）只更新路径/别名/远程配置，保留原 sortIndex。
    const { n } = this.db.prepare('SELECT COALESCE(MAX(sortIndex), -1) + 1 AS n FROM homes').get();
    this.db.prepare(
      `INSERT INTO homes (homeId, homePath, alias, hostType, status, sortIndex, host, remotePort, remoteHome, remoteCmd, remoteLog)
       VALUES (?, ?, ?, ?, 'unknown', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(homeId) DO UPDATE SET
         homePath = excluded.homePath, alias = excluded.alias,
         hostType = excluded.hostType, host = excluded.host,
         remotePort = excluded.remotePort, remoteHome = excluded.remoteHome,
         remoteCmd = excluded.remoteCmd, remoteLog = excluded.remoteLog`
    ).run(homeId, homePath, alias, hostType, n, host, remotePort, remoteHome, remoteCmd, remoteLog);
    return homeId;
  }

  listHomePaths() {
    return this.db.prepare('SELECT homePath FROM homes ORDER BY (sortIndex IS NULL), sortIndex, homeId').all().map((r) => r.homePath);
  }

  // 索引器只用本地 home 的路径（远程实例的元数据不本地索引，走 tunnel 访问）。
  listLocalHomePaths() {
    return this.db.prepare("SELECT homePath FROM homes WHERE hostType = 'local' ORDER BY (sortIndex IS NULL), sortIndex, homeId").all().map((r) => r.homePath);
  }

  // 拖拽排序持久化：把 homeIds 依次写为 sortIndex 0..n-1。
  setHomeOrder(homeIds) {
    const up = this.db.prepare('UPDATE homes SET sortIndex = ? WHERE homeId = ?');
    this.db.exec('BEGIN');
    try {
      homeIds.forEach((id, i) => up.run(i, id));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getHome(homeId) {
    return this.listHomes().find((h) => h.homeId === homeId) ?? null;
  }

  removeHome(homeId) {
    this.db.exec('BEGIN');
    try {
      for (const table of ['sessions', 'workspaces', 'providers', 'model_tiers', 'homes']) {
        this.db.prepare(`DELETE FROM ${table} WHERE homeId = ?`).run(homeId);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // 更新实例配置（alias + homePath/远程连接参数）；未提供的字段保留原值。
  // 本地实例改 homePath → homeId 变化，会重新键控（连同子行）为同一逻辑实例。
  updateHomeConfig(homeId, patch = {}) {
    const cur = this.getHome(homeId);
    if (!cur) return null;

    if (cur.hostType === 'local' && typeof patch.homePath === 'string' && patch.homePath.trim()) {
      const newPath = path.resolve(patch.homePath.trim());
      const newHomeId = homeIdOf(newPath);
      if (newHomeId !== homeId) {
        if (this.getHome(newHomeId)) {
          throw new Error(`目标路径已注册为另一个实例: ${newPath}`);
        }
        this.db.exec('BEGIN');
        try {
          for (const table of ['sessions', 'workspaces', 'providers', 'model_tiers']) {
            this.db.prepare(`UPDATE ${table} SET homeId = ? WHERE homeId = ?`).run(newHomeId, homeId);
          }
          this.db.prepare('UPDATE homes SET homeId = ?, homePath = ? WHERE homeId = ?').run(newHomeId, newPath, homeId);
          this.db.exec('COMMIT');
        } catch (e) {
          this.db.exec('ROLLBACK');
          throw e;
        }
        homeId = newHomeId;
      }
    }

    const cur2 = this.getHome(homeId);
    const alias = patch.alias !== undefined ? patch.alias : cur2.alias;
    const host = patch.host !== undefined ? patch.host : cur2.host;
    const remotePort = patch.remotePort !== undefined ? patch.remotePort : cur2.remotePort;
    const remoteHome = patch.remoteHome !== undefined ? patch.remoteHome : cur2.remoteHome;
    const remoteCmd = patch.remoteCmd !== undefined ? patch.remoteCmd : cur2.remoteCmd;
    const remoteLog = patch.remoteLog !== undefined ? patch.remoteLog : cur2.remoteLog;
    this.db.prepare('UPDATE homes SET alias = ?, host = ?, remotePort = ?, remoteHome = ?, remoteCmd = ?, remoteLog = ? WHERE homeId = ?')
      .run(alias, host, remotePort, remoteHome, remoteCmd, remoteLog, homeId);
    return this.getHome(homeId);
  }

  markHomeError(homeId, error) {
    this.db.prepare(
      `UPDATE homes SET status = 'degraded',
       degraded = json_array(json_object('domain', 'index', 'error', ?, 'degraded', json('true')))
       WHERE homeId = ?`
    ).run(String(error), homeId);
  }

  // Full-refresh per home: child rows for a home are replaced wholesale.
  upsertRows(rows) {
    const homeRows = rows.filter((r) => r.type === 'home');
    const homeIds = homeRows.map((r) => r.homeId);

    this.db.exec('BEGIN');
    try {
      for (const homeId of homeIds) {
        for (const table of ['sessions', 'workspaces', 'providers', 'model_tiers']) {
          this.db.prepare(`DELETE FROM ${table} WHERE homeId = ?`).run(homeId);
        }
      }

      const insSession = this.db.prepare(
        `INSERT INTO sessions (homeId, sessionId, workspaceId, workspaceTitle, project, title, tokenUsage, contextPressure, status, lastActivity, generatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insWorkspace = this.db.prepare(
        `INSERT INTO workspaces (homeId, workspaceId, title, path, project, archived, sessionCount)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const insProvider = this.db.prepare(
        `INSERT INTO providers (homeId, ref, provider) VALUES (?, ?, ?)`
      );
      const insTier = this.db.prepare(
        `INSERT INTO model_tiers (homeId, tierId, active, provider, model) VALUES (?, ?, ?, ?, ?)`
      );
      const upHome = this.db.prepare(
        `INSERT INTO homes (homeId, homePath, status, lastIndexedAt, degraded)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(homeId) DO UPDATE SET
           homePath = excluded.homePath,
           status = excluded.status,
           lastIndexedAt = excluded.lastIndexedAt,
           degraded = excluded.degraded`
      );

      for (const row of rows) {
        switch (row.type) {
          case 'home':
            upHome.run(
              row.homeId,
              row.homePath,
              row.degraded.length === 0 ? 'ok' : 'degraded',
              row.generatedAt,
              JSON.stringify(row.degraded)
            );
            break;
          case 'session':
            insSession.run(
              row.homeId, row.sessionId, row.workspaceId, row.workspaceTitle,
              row.project, row.title ?? null, row.tokenUsage, row.contextPressure, row.status, row.lastActivity, row.generatedAt
            );
            break;
          case 'workspace':
            insWorkspace.run(
              row.homeId, row.workspaceId, row.title, row.path,
              row.project, row.archived ? 1 : 0, row.sessionCount
            );
            break;
          case 'provider':
            insProvider.run(row.homeId, row.ref, row.provider);
            break;
          case 'modelTier':
            insTier.run(row.homeId, row.tierId, row.active ? 1 : 0, row.provider, row.model);
            break;
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  listHomes() {
    const homes = this.db.prepare(
      `SELECT h.homeId, h.homePath, h.alias, h.hostType, h.status, h.lastIndexedAt, h.degraded,
              h.host, h.remotePort, h.remoteHome, h.remoteCmd, h.remoteLog,
              (SELECT COUNT(*) FROM sessions s WHERE s.homeId = h.homeId) AS sessionCount,
              (SELECT COUNT(*) FROM workspaces w WHERE w.homeId = h.homeId) AS workspaceCount
       FROM homes h ORDER BY (h.sortIndex IS NULL), h.sortIndex, h.homeId`
    ).all();
    const providers = this.db.prepare('SELECT homeId, ref, provider FROM providers WHERE homeId = ? ORDER BY provider');
    const tiers = this.db.prepare("SELECT homeId, tierId, provider, model FROM model_tiers WHERE homeId = ? AND active = 1 ORDER BY CASE WHEN tierId = 'default' THEN 0 ELSE 1 END");
    return homes.map((h) => ({
      ...h,
      degraded: JSON.parse(h.degraded || '[]'),
      providers: providers.all(h.homeId),
      activeTier: tiers.get(h.homeId) ?? null,
    }));
  }

  // Recent projects: cross-instance, active within `days`, ordered by last activity (§7.1).
  // 每个 project 附带"它所属的实例 + 该 project 最新会话"，供点击直接跳转。
  recentProjects({ days = 7, limit = 20 } = {}) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const projects = this.db.prepare(
      `SELECT s.project,
              COUNT(*) AS sessionCount,
              MAX(s.lastActivity) AS lastActivity,
              SUM(COALESCE(json_extract(s.tokenUsage, '$.uncachedInputTokens'), 0)
                + COALESCE(json_extract(s.tokenUsage, '$.cacheReadTokens'), 0)
                + COALESCE(json_extract(s.tokenUsage, '$.cacheWriteTokens'), 0)) AS inputTokens,
              SUM(COALESCE(json_extract(s.tokenUsage, '$.outputTokens'), 0)) AS outputTokens,
              (SELECT x.homeId FROM sessions x WHERE x.project = s.project
                 ORDER BY x.lastActivity DESC, x.rowid DESC LIMIT 1) AS homeId,
              (SELECT x.sessionId FROM sessions x WHERE x.project = s.project
                 ORDER BY x.lastActivity DESC, x.rowid DESC LIMIT 1) AS sessionId,
              (SELECT x.workspaceId FROM sessions x WHERE x.project = s.project
                 ORDER BY x.lastActivity DESC, x.rowid DESC LIMIT 1) AS workspaceId
       FROM sessions s
       WHERE s.project IS NOT NULL AND s.lastActivity IS NOT NULL AND s.lastActivity >= ?
       GROUP BY s.project
       ORDER BY s.lastActivity DESC
       LIMIT ${int(limit, 20)}`
    ).all(since);

    // Workspaces with no sessions still show up as projects (§4.5) — 跳到其所属实例，
    // 无最新会话，sessionId 为 null。
    const orphanWs = this.db.prepare(
      `SELECT w.project AS project, 0 AS sessionCount, NULL AS lastActivity,
              0 AS inputTokens, 0 AS outputTokens,
              w.homeId AS homeId, NULL AS sessionId, w.workspaceId AS workspaceId
       FROM workspaces w
       WHERE w.archived = 0 AND NOT EXISTS (
         SELECT 1 FROM sessions s WHERE s.homeId = w.homeId AND s.workspaceId = w.workspaceId
       )`
    ).all();
    const seen = new Set(projects.map((p) => p.project));
    for (const w of orphanWs) {
      if (!seen.has(w.project)) projects.push(w);
    }
    return projects.slice(0, int(limit, 20));
  }

  recentSessions({ homeId = null, limit = 50 } = {}) {
    const where = homeId ? 'WHERE homeId = ?' : '';
    const args = homeId ? [homeId] : [];
    return this.db.prepare(
      `SELECT homeId, sessionId, workspaceId, workspaceTitle, project, title, tokenUsage, contextPressure, status, lastActivity
       FROM sessions ${where}
       ORDER BY lastActivity DESC NULLS LAST
       LIMIT ${int(limit, 50)}`
    ).all(...args).map((s) => ({
      ...s,
      tokenUsage: s.tokenUsage ? JSON.parse(s.tokenUsage) : null,
      contextPressure: s.contextPressure ? JSON.parse(s.contextPressure) : null,
      status: s.status ? JSON.parse(s.status) : null,
    }));
  }

  // Token 用量汇总（基于会话聚合 tokenUsage）：总 Tokens / 输入 / 输出 / 缓存命中 / 缓存创建 / 缓存命中率。
  usageSummary({ days = 30 } = {}) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const r = this.db.prepare(
      `SELECT
         COUNT(*) AS sessionCount,
         COALESCE(SUM(json_extract(tokenUsage, '$.uncachedInputTokens')), 0) AS inputTokens,
         COALESCE(SUM(json_extract(tokenUsage, '$.outputTokens')), 0) AS outputTokens,
         COALESCE(SUM(json_extract(tokenUsage, '$.cacheReadTokens')), 0) AS cacheRead,
         COALESCE(SUM(json_extract(tokenUsage, '$.cacheWriteTokens')), 0) AS cacheWrite,
         COALESCE(SUM(json_extract(tokenUsage, '$.uncachedInputTokens')
                 + json_extract(tokenUsage, '$.outputTokens')
                 + json_extract(tokenUsage, '$.cacheReadTokens')
                 + json_extract(tokenUsage, '$.cacheWriteTokens')), 0) AS totalTokens
       FROM sessions
       WHERE lastActivity IS NOT NULL AND lastActivity >= ?`
    ).get(since);
    const hit = r.inputTokens + r.cacheRead;
    return {
      days,
      sessionCount: r.sessionCount,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheRead: r.cacheRead,
      cacheWrite: r.cacheWrite,
      totalTokens: r.totalTokens,
      cacheHitRate: hit > 0 ? r.cacheRead / hit : 0,
    };
  }

  // 分时用量趋势：按小时分桶（最后 `hours` 小时），填充空白桶使图表连续。
  usageTrend({ hours = 24 } = {}) {
    const now = Date.now();
    const start = now - hours * 3_600_000;
    const startIso = new Date(start).toISOString();
    const rows = this.db.prepare(
      `SELECT CAST(STRFTIME('%s', lastActivity) / 3600 AS INTEGER) AS h,
              COALESCE(SUM(json_extract(tokenUsage, '$.uncachedInputTokens')), 0) AS inputTokens,
              COALESCE(SUM(json_extract(tokenUsage, '$.outputTokens')), 0) AS outputTokens,
              COALESCE(SUM(json_extract(tokenUsage, '$.cacheReadTokens')), 0) AS cacheRead,
              COALESCE(SUM(json_extract(tokenUsage, '$.cacheWriteTokens')), 0) AS cacheWrite
       FROM sessions
       WHERE lastActivity IS NOT NULL AND lastActivity >= ?
       GROUP BY h`
    ).all(startIso);
    const byH = new Map(rows.map((r) => [r.h, r]));
    const startHour = Math.floor(start / 3_600_000);
    const buckets = [];
    for (let i = hours - 1; i >= 0; i--) {
      const h = startHour + i;
      const r = byH.get(h);
      buckets.push({
        ts: new Date(h * 3_600_000).toISOString(),
        input: r ? r.inputTokens : 0,
        output: r ? r.outputTokens : 0,
        cacheRead: r ? r.cacheRead : 0,
        cacheWrite: r ? r.cacheWrite : 0,
      });
    }
    return buckets;
  }

  // 按项目拆分的 Token 用量（跨实例聚合）。
  usageByProject({ days = 30, limit = 15 } = {}) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.db.prepare(
      `SELECT project,
              COUNT(*) AS sessionCount,
              COALESCE(SUM(json_extract(tokenUsage, '$.uncachedInputTokens')
                      + json_extract(tokenUsage, '$.outputTokens')
                      + json_extract(tokenUsage, '$.cacheReadTokens')
                      + json_extract(tokenUsage, '$.cacheWriteTokens')), 0) AS tokens
       FROM sessions
       WHERE project IS NOT NULL AND lastActivity IS NOT NULL AND lastActivity >= ?
       GROUP BY project
       ORDER BY tokens DESC
       LIMIT ${int(limit, 15)}`
    ).all(since);
  }

  // 分维度（total|project|instance|provider）、按周期自适应粒度的 token 聚合，供堆叠柱状图。
  // 每个 bucket 的 groups 是与维度对应的 { 标签: tokens }；total 维度只有一个「合计」组。
  // 返回 { dimension, hours, stepMs, buckets }；stepMs 为每桶毫秒（提示前端按此格式化 X 轴标签）。
  usageTrendGrouped({ dimension = 'total', hours = 24 } = {}) {
    const now = Date.now();
    const stepMs = bucketStepMs(hours);
    const stepSec = Math.round(stepMs / 1000);
    const bucketCount = Math.max(1, Math.round((hours * 3_600_000) / stepMs));
    const endBucket = Math.floor(now / stepMs);      // 当前桶索引（对齐 UTC 纪元）
    const startBucket = endBucket - bucketCount + 1;
    const startIso = new Date(startBucket * stepMs).toISOString();
    const groupExpr = dimension === 'instance'
      ? 's.homeId'
      : dimension === 'provider'
        ? `COALESCE(
             (SELECT NULLIF(provider, '') FROM model_tiers t
               WHERE t.homeId = s.homeId AND t.active = 1
               ORDER BY CASE WHEN t.tierId = 'default' THEN 0 ELSE 1 END LIMIT 1),
             (SELECT provider FROM providers p WHERE p.homeId = s.homeId ORDER BY p.rowid LIMIT 1),
             'unknown')`
        : dimension === 'total'
          ? "'合计'"
          : `COALESCE(s.project, '(未分类)')`;
    const rows = this.db.prepare(
      `SELECT CAST(STRFTIME('%s', s.lastActivity) / ? AS INTEGER) AS h,
              ${groupExpr} AS grp,
              COALESCE(SUM(json_extract(s.tokenUsage, '$.uncachedInputTokens')
                      + json_extract(s.tokenUsage, '$.outputTokens')
                      + json_extract(s.tokenUsage, '$.cacheReadTokens')
                      + json_extract(s.tokenUsage, '$.cacheWriteTokens')), 0) AS tokens
       FROM sessions s
       WHERE s.lastActivity IS NOT NULL AND s.lastActivity >= ?
       GROUP BY h, grp
       ORDER BY h, tokens DESC`
    ).all(stepSec, startIso);

    // instance 维度 group 是 homeId，在这里映射为可读标签（alias || 目录名 || homeId）。
    const homeLabel = this.#homeLabelMap();
    const byH = new Map();
    for (const r of rows) {
      let label = r.grp;
      if (dimension === 'instance') label = homeLabel.get(r.grp) ?? r.grp;
      if (!byH.has(r.h)) byH.set(r.h, {});
      const g = byH.get(r.h);
      g[label] = (g[label] ?? 0) + r.tokens;
    }
    const buckets = [];
    for (let i = 0; i < bucketCount; i++) {
      const h = startBucket + i;
      const groups = byH.get(h) ?? {};
      const total = Object.values(groups).reduce((a, b) => a + b, 0);
      buckets.push({ ts: new Date(h * stepMs).toISOString(), groups, total });
    }
    return { dimension, hours, stepMs, buckets };
  }

  #homeLabelMap() {
    const homes = this.db.prepare('SELECT homeId, homePath, alias FROM homes').all();
    const m = new Map();
    for (const h of homes) {
      const base = h.homePath ? path.basename(h.homePath) : h.homeId;
      m.set(h.homeId, (h.alias && String(h.alias).trim()) || base);
    }
    return m;
  }

  listWorkspaces({ homeId = null } = {}) {
    const where = homeId ? 'WHERE homeId = ?' : '';
    const args = homeId ? [homeId] : [];
    return this.db.prepare(
      `SELECT homeId, workspaceId, title, path, project, archived, sessionCount
       FROM workspaces ${where} ORDER BY project`
    ).all(...args);
  }
}
