import { normalizeEndpoints, endpointPatch, legacyEndpoint } from '../lib/endpoints.js';
import { normalizeAccessPort } from '../lib/access-port.js';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { homeIdOf } from '../lib/read-home.js';
import { mergeLiveStatus } from './reader.js';
import { logger } from '../lib/logger.js';

const log = logger('store');

// 每个 home 的子表（整表替换的粒度）。
const CHILD_TABLES = ['sessions', 'workspaces', 'providers', 'model_tiers'];

// 降级域 → 它负责填充的子表。见 upsertRows 的注释：降级域对应的表必须保留上次成功的行。
// 未列出的域（例如 markHomeError 写的 'index'）不保护任何表——那类失败走的是 catch 分支，
// 不会经过 upsertRows。
const DOMAIN_TABLES = {
  projcache: 'sessions',
  workspace: 'workspaces',
  credentials: 'providers',
  modelTier: 'model_tiers',
};

function degradedTables(degraded) {
  const tables = new Set();
  for (const entry of Array.isArray(degraded) ? degraded : []) {
    const table = DOMAIN_TABLES[entry?.domain];
    if (table) tables.add(table);
  }
  return tables;
}

// listHomes 与 getHome 共用的实例基础查询：单实例点查只需在末尾拼一个 WHERE。
const HOME_SELECT = `SELECT h.homeId, h.homePath, h.alias, h.hostType, h.status, h.lastIndexedAt, h.degraded,
              h.endpoints, h.activeEndpointId, h.serverId, h.host, h.remotePort, h.localPort, h.accessPort, h.remoteHome, h.remoteCmd, h.remoteLog, h.token,
              (SELECT COUNT(*) FROM sessions s WHERE s.homeId = h.homeId) AS sessionCount,
              (SELECT COUNT(*) FROM workspaces w WHERE w.homeId = h.homeId) AS workspaceCount
       FROM homes h`;

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
  localPort INTEGER,
  remoteHome TEXT,
  remoteCmd TEXT,
  remoteLog TEXT,
  token TEXT
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
  -- tokenUsage 的派生列：四个计数从 JSON 里解出来的整数。
  -- 为什么要冗余：/api/usage 要跑八个聚合，而逐行 json_extract 在真实规模下很贵
  -- （实测 40k 会话合计 ~330ms，而 node:sqlite 是同步的 —— 那段时间整个单线程服务都停着）。
  -- 落成整数列之后聚合就是普通 SUM。真相仍是 tokenUsage（读接口照旧返回它），
  -- 这两列由下面的触发器维护（任何写入者都算数），并与「直接对 JSON 跑 json_extract」的结果
  -- 在 tests/store-token-columns.test.js 里逐项对拍。
  -- 代价（实测 20k 行）：有触发器 172ms / 无 43ms —— 每行多一次 UPDATE；换来的是读侧
  -- 等价 5 条聚合 175ms → 76ms（同一份 40k 数据）。按秒计的阻塞是净减少的。
  -- 注意：这段注释里不能出现反引号 —— 它在 SCHEMA 模板字符串内部，反引号会提前结束字符串。
  tokInput INTEGER NOT NULL DEFAULT 0,
  tokOutput INTEGER NOT NULL DEFAULT 0,
  tokCacheRead INTEGER NOT NULL DEFAULT 0,
  tokCacheWrite INTEGER NOT NULL DEFAULT 0,
  contextPressure TEXT,
  status TEXT,
  lastActivity TEXT,
  generatedAt TEXT,
  -- 1 = 这行只来自实时 RPC（dsh 的 /api/session/list），文件索引里还没有它。
  -- 用来在「实时列表变成空」时精确清掉这些行，而不会误伤有文件索引支撑的会话。
  liveOnly INTEGER NOT NULL DEFAULT 0,
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
-- 派生列由**触发器**维护，而不是由 JS 写入：任何写入者（包括裸 SQL、外部工具改库）都不会
-- 让两列与 tokenUsage 漂移。JS 侧不再参与，读路径也不解析 JSON。
-- 表达式与旧的 json_valid/json_extract 写法逐项等价（json_valid 挡住非法 JSON → 0）。
-- 注意 AFTER INSERT 里的 UPDATE 不会递归触发下面那个 UPDATE 触发器：SQLite 默认
-- recursive_triggers=OFF（本文件不打开它）——若哪天要打开，这两个触发器必须重新设计。
CREATE TRIGGER IF NOT EXISTS sessions_tok_ai AFTER INSERT ON sessions BEGIN
  UPDATE sessions SET
    tokInput = CASE WHEN json_valid(NEW.tokenUsage) THEN COALESCE(json_extract(NEW.tokenUsage, '$.uncachedInputTokens'), 0) ELSE 0 END,
    tokOutput = CASE WHEN json_valid(NEW.tokenUsage) THEN COALESCE(json_extract(NEW.tokenUsage, '$.outputTokens'), 0) ELSE 0 END,
    tokCacheRead = CASE WHEN json_valid(NEW.tokenUsage) THEN COALESCE(json_extract(NEW.tokenUsage, '$.cacheReadTokens'), 0) ELSE 0 END,
    tokCacheWrite = CASE WHEN json_valid(NEW.tokenUsage) THEN COALESCE(json_extract(NEW.tokenUsage, '$.cacheWriteTokens'), 0) ELSE 0 END
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS sessions_tok_au AFTER UPDATE OF tokenUsage ON sessions BEGIN
  UPDATE sessions SET
    tokInput = CASE WHEN json_valid(NEW.tokenUsage) THEN COALESCE(json_extract(NEW.tokenUsage, '$.uncachedInputTokens'), 0) ELSE 0 END,
    tokOutput = CASE WHEN json_valid(NEW.tokenUsage) THEN COALESCE(json_extract(NEW.tokenUsage, '$.outputTokens'), 0) ELSE 0 END,
    tokCacheRead = CASE WHEN json_valid(NEW.tokenUsage) THEN COALESCE(json_extract(NEW.tokenUsage, '$.cacheReadTokens'), 0) ELSE 0 END,
    tokCacheWrite = CASE WHEN json_valid(NEW.tokenUsage) THEN COALESCE(json_extract(NEW.tokenUsage, '$.cacheWriteTokens'), 0) ELSE 0 END
  WHERE id = NEW.id;
END;
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(lastActivity DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_home ON sessions(homeId);
`;

// 把「N 天前」算成 ISO 时间戳。上限 100 年：既覆盖任何合理查询，也保证结果一定落在
// ECMAScript 的日期范围内（|ms| ≤ 8.64e15）。超出范围时 toISOString 会抛 RangeError，
// 而那会把一次查询变成 500。
function daysAgoIso(days) {
  const n = Number(days);
  const safe = Number.isFinite(n) ? Math.min(Math.max(n, 0), 36_500) : 0;
  return new Date(Date.now() - safe * 86_400_000).toISOString();
}

// tokenUsage 是 TEXT 列，里面存 JSON。`json_extract` 遇到**非法 JSON** 会直接让整条 SQL
// 报 `malformed JSON` —— 于是**一行**脏数据就把 /api/usage 与 /api/projects/recent 打成 500
// （读路径上的 safeJsonParse 只保护行映射，管不到 SQL 聚合）。
// 因此下面所有取值都写成 `CASE WHEN json_valid(x) THEN json_extract(x,'$.k') ELSE NULL END`
// （外层再 COALESCE 成 0）：非法 JSON 视同「该字段不存在」，按 0 计入，
// 而不是让整块面板一起不可用。
//
// 注意：加法一定要**逐项** COALESCE。写成 COALESCE(SUM(a + b + c + d), 0) 时，
// 只要某个键缺失，整个相加就是 NULL、SUM 又忽略 NULL —— totalTokens 会变成 0。

// token 派生列的迁移版本（PRAGMA user_version）、列名与回填表达式。
// 回填表达式与 SCHEMA 里那两个触发器**必须一致** —— 用同一段字符串生成，避免两套算法漂移。
// （SQLite 的多语句 exec 中途失败时，前面已成功的语句是保留的，所以补列必须逐列判断。）
const TOKEN_COLUMNS_VERSION = 1;
const TOKEN_COLUMN_NAMES = ['tokInput', 'tokOutput', 'tokCacheRead', 'tokCacheWrite'];
const TOKEN_EXPR = {
  tokInput: "CASE WHEN json_valid(tokenUsage) THEN COALESCE(json_extract(tokenUsage, '$.uncachedInputTokens'), 0) ELSE 0 END",
  tokOutput: "CASE WHEN json_valid(tokenUsage) THEN COALESCE(json_extract(tokenUsage, '$.outputTokens'), 0) ELSE 0 END",
  tokCacheRead: "CASE WHEN json_valid(tokenUsage) THEN COALESCE(json_extract(tokenUsage, '$.cacheReadTokens'), 0) ELSE 0 END",
  tokCacheWrite: "CASE WHEN json_valid(tokenUsage) THEN COALESCE(json_extract(tokenUsage, '$.cacheWriteTokens'), 0) ELSE 0 END",
};
const TOKEN_COLUMNS_SET = TOKEN_COLUMN_NAMES.map((c) => `${c} = ${TOKEN_EXPR[c]}`).join(', ');

// 用量聚合直接 SUM 派生整数列（由触发器维护，见 SCHEMA）。收益：40k 会话下八个聚合从 ~330ms
// 降到普通 SUM 的量级（node:sqlite 是同步的，那段时间整个服务都停着）。
const TOK = {
  input: 'COALESCE(SUM(tokInput), 0)',
  output: 'COALESCE(SUM(tokOutput), 0)',
  cacheRead: 'COALESCE(SUM(tokCacheRead), 0)',
  cacheWrite: 'COALESCE(SUM(tokCacheWrite), 0)',
  total: 'COALESCE(SUM(tokInput + tokOutput + tokCacheRead + tokCacheWrite), 0)',
};

// 「实时写入活跃」的宽限期：该 home 在这个窗口内有过实时状态写入时，文件索引的整表替换不能把
// status/lastActivity 一起带走（见 upsertRows）。比轮询间隔（3s）宽裕，又足够短：通道一停，
// 宽限期结束，文件索引重新拿到权威。
const LIVE_GRACE_MS = 10_000;

const int = (v, dflt) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : dflt;
};

// 依据统计周期自动选择分桶粒度：短周期更细、长周期更粗，使点图数据点保持在合理范围。
// hours → 每桶毫秒。24h=15分钟(96点) / 3d=1小时(72点) / 7d=3小时(56点) / 14d=6小时(56点) / 30d=12小时(60点)。
function bucketStepMs(hours) {
  if (hours <= 24) return 15 * 60_000;       // 15 分钟
  if (hours <= 72) return 60 * 60_000;       // 1 小时
  if (hours <= 168) return 3 * 60 * 60_000;  // 3 小时
  if (hours <= 336) return 6 * 60 * 60_000;  // 6 小时
  return 12 * 60 * 60_000;                   // 12 小时
}

// 读路径上的 JSON 列必须**容错**：这些列由我们写入，但文件可以被外部工具改、进程可能被
// 强杀在写入中途、旧版本可能写过别的形状。一个坏值不该让整个工作台消失 ——
// 原实现是裸 JSON.parse，而 `#enrichHome` 会被 LiveStatusPoller 的定时器**同步**调用，
// 于是 SyntaxError 直接冒成 uncaughtException → crash handler → process.exit(1)。
// 实测：只要 homes.endpoints / homes.degraded / sessions.status / sessions.tokenUsage
// 里有一个不是合法 JSON，进程在启动后 3 秒内必退，且日志里只有一句 JSON 解析错误。
// 这里统一降级为 fallback，并记一次 warn（同一个字段只记一次，避免刷屏）。
const warnedJsonColumns = new Set();
function safeJsonParse(raw, fallback, label) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    if (label && !warnedJsonColumns.has(label)) {
      warnedJsonColumns.add(label);
      log.warn('数据库里的 JSON 列无法解析，已降级为默认值（该行可能被外部工具改过）', { column: label });
    }
    return fallback;
  }
}

export class IndexStore {
  // homeId -> 最近一次实时状态写入时间（见 liveStatusAt/applyLiveStatus）
  #liveWrittenAt;
  constructor(dbPath = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    this.#liveWrittenAt = new Map();
    this.dbPath = dbPath;
    try {
      this.db.exec(SCHEMA);   // 建表 + 建触发器（在只读库上这一步就会写失败）
      this.migrate();
    } catch (error) {
      // 把「初始化/迁移失败」说清楚：底层可能只是 `attempt to write a readonly database`
      // 或 `database or disk is full`，用户看不出该怎么恢复。迁移与建表都是**幂等**的，
      // 所以明确告诉他「修好后重启会自动继续」，而不是让他以为库坏了要重建。
      throw new Error(`数据库初始化/迁移失败（${dbPath}）：${error?.message ?? error}。`
        + '若是权限或磁盘空间问题，修复后重启会自动重试（建表与迁移都是幂等的）；'
        + '若这个文件根本不是 SQLite 数据库，请改名或换一个路径。');
    }
  }

  // 派生列的迁移：补列 + 回填，**同一个事务**，并用 `PRAGMA user_version` 记录「回填成功」。
  //
  // 为什么必须这样（审查实测过旧实现的失败后果）：旧的写法里四个 ALTER 各自自动提交（DDL 不在
  // 事务里），而回填另起一个事务。回填一旦失败（磁盘满、进程被杀 —— 4 万行回填约 60ms，窗口真实
  // 存在），列已经存在，于是下次启动那个「按列判断」的闸门不会再回填 → **所有历史用量永久为 0**，
  // 没有任何报错、没有 degraded 标记。实测：SQLITE_FULL 之后第二次启动 usageSummary.totalTokens = 0，
  // 而直接对 JSON 跑 json_extract 的预言机是 82000000。
  // 另外逐列判断缺哪补哪：SQLite 的多语句 exec 在中途失败时**前面成功的语句是保留的**，
  // 于是可能出现「四列只加了一两列」的库，那种库会让每个用量查询报 no such column（审查也复现了）。
  // 回填表达式与触发器共用同一段 SQL（TOKEN_COLUMNS_SET）：两边各写一套算法迟早漂移。
  // 失败时抛出去，由 server.js 打印明确提示并退出 —— 宁可启动失败并说清楚，也不要静默把整段
  // 历史显示成 0；user_version 没抬上去 ⇒ 下次启动会自动重试（回填幂等）。
  #migrateTokenColumns(sess) {
    const missing = TOKEN_COLUMN_NAMES.filter((c) => !sess.includes(c));
    const applied = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0) >= TOKEN_COLUMNS_VERSION;
    if (missing.length === 0 && applied) return;
    try {
      // BEGIN 也要在 try 里：只读库上它自己就会抛（实测），那样就绕过下面这层包装，
      // 用户只会看到一句 `attempt to write a readonly database`，不知道是迁移失败、更不知道该重试。
      this.db.exec('BEGIN');
      for (const name of missing) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
      this.db.exec(`UPDATE sessions SET ${TOKEN_COLUMNS_SET} WHERE tokenUsage IS NOT NULL`);
      this.db.exec(`PRAGMA user_version = ${TOKEN_COLUMNS_VERSION}`);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* 磁盘满时 SQLite 可能已经自动回滚 */ }
      throw new Error(`数据库迁移失败（token 派生列）：${error?.message ?? error}。`
        + '修复磁盘空间/权限后重启会自动重试（回填是幂等的）；在此之前请勿继续使用，'
        + '否则历史用量会显示为 0。');
    }
  }

  migrate() {
    const sess = this.db.prepare("SELECT name FROM pragma_table_info('sessions')").all().map((c) => c.name);
    if (!sess.includes('title')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN title TEXT');
    }
    if (!sess.includes('liveOnly')) {
      // 已有库里的行都来自文件索引或早期实时合并：默认 0 最保守（不会被空实时列表误删）。
      this.db.exec('ALTER TABLE sessions ADD COLUMN liveOnly INTEGER NOT NULL DEFAULT 0');
    }
    if (!sess.includes('status')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN status TEXT');
    }
    this.#migrateTokenColumns(sess);
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
    if (!homes.includes('localPort')) {
      this.db.exec('ALTER TABLE homes ADD COLUMN localPort INTEGER');
    }
    if (!homes.includes('accessPort')) this.db.exec('ALTER TABLE homes ADD COLUMN accessPort INTEGER');
    this.db.exec("UPDATE homes SET accessPort = NULL WHERE hostType != 'remote' AND accessPort IS NOT NULL");
    // 先去掉重复的 accessPort 再建唯一索引：手改过库（或早期版本写坏）时，重复值会让这条
    // DDL 失败 —— 而它在启动路径上，于是**每次启动都失败**，用户只能自己拿 sqlite 去改库。
    // 保留 sortIndex 最小（界面顺序靠前）的那条，其余置空；用户重新分配即可。
    const dupPorts = this.db.prepare(
      'SELECT accessPort FROM homes WHERE accessPort IS NOT NULL GROUP BY accessPort HAVING COUNT(*) > 1'
    ).all();
    for (const d of dupPorts) {
      const keep = this.db.prepare(
        'SELECT homeId FROM homes WHERE accessPort = ? ORDER BY COALESCE(sortIndex, 2147483647), homeId LIMIT 1'
      ).get(d.accessPort);
      this.db.prepare('UPDATE homes SET accessPort = NULL WHERE accessPort = ? AND homeId <> ?').run(d.accessPort, keep.homeId);
      log.warn('发现重复的接入端口，已保留一个并清空其余（可在界面重新分配）', { accessPort: d.accessPort, kept: keep.homeId });
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS homes_access_port ON homes(accessPort) WHERE accessPort IS NOT NULL');
    if (!homes.includes('remoteHome')) {
      this.db.exec('ALTER TABLE homes ADD COLUMN remoteHome TEXT');
    }
    if (!homes.includes('remoteCmd')) {
      this.db.exec('ALTER TABLE homes ADD COLUMN remoteCmd TEXT');
    }
    if (!homes.includes('remoteLog')) {
      this.db.exec('ALTER TABLE homes ADD COLUMN remoteLog TEXT');
    }
    if (!homes.includes('serverId')) {
      this.db.exec('ALTER TABLE homes ADD COLUMN serverId TEXT');
      // 用户确认的同机双通道；仅迁移这两个明确的 SSH 别名。
      const channels = this.db.prepare("SELECT homeId, host FROM homes WHERE hostType = 'remote'").all();
      const assign = this.db.prepare('UPDATE homes SET serverId = ? WHERE homeId = ?');
      for (const h of channels) {
        if (['cms.lo', 'cms.tun'].includes(h.host?.split('@').pop())) assign.run('cms', h.homeId);
      }
    }
    if (!homes.includes('token')) {
      this.db.exec('ALTER TABLE homes ADD COLUMN token TEXT');
    }
    if (!homes.includes('endpoints')) this.#migrateEndpoints();
  }

  // 预编译语句的缓存位（见 #enrichHome：listHomes 与 getHome 共用同一组语句）。
  #providersStmt = null;
  #tiersStmt = null;

  #migrateEndpoints() {
    this.db.exec('BEGIN');
    try {
      this.db.exec("ALTER TABLE homes ADD COLUMN endpoints TEXT NOT NULL DEFAULT '[]'");
      this.db.exec('ALTER TABLE homes ADD COLUMN activeEndpointId TEXT');
      const homes = this.db.prepare('SELECT * FROM homes ORDER BY (sortIndex IS NULL), sortIndex, homeId').all();
      const groups = new Map();
      for (const home of homes) {
        const endpoint = legacyEndpoint(home);
        const remoteHome = (home.remoteHome || '~/.dsh').replace(/\/+$/, '');
        const user = remoteHome.startsWith('/') ? '' : (home.host?.includes('@') ? home.host.slice(0, home.host.lastIndexOf('@')) : '');
        const key = home.hostType === 'remote' && home.serverId
          ? JSON.stringify([home.serverId, user, remoteHome]) : home.homeId;
        const group = groups.get(key);
        if (!group) { groups.set(key, { home, endpoints: endpoint ? [endpoint] : [] }); continue; }
        if (endpoint && !group.endpoints.some((e) => e.host === endpoint.host && e.port === endpoint.port)) group.endpoints.push(endpoint);
        // 同一逻辑实例的索引归入保留的 homeId；重复 session/workspace 只保留一份。
        for (const table of ['sessions', 'workspaces', 'providers', 'model_tiers']) {
          this.db.prepare(`UPDATE OR IGNORE ${table} SET homeId = ? WHERE homeId = ?`).run(group.home.homeId, home.homeId);
          this.db.prepare(`DELETE FROM ${table} WHERE homeId = ?`).run(home.homeId);
        }
        this.db.prepare('DELETE FROM homes WHERE homeId = ?').run(home.homeId);
      }
      const update = this.db.prepare('UPDATE homes SET endpoints = ?, activeEndpointId = ? WHERE homeId = ?');
      for (const { home, endpoints } of groups.values()) update.run(JSON.stringify(endpoints), endpoints[0]?.id || null, home.homeId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  close() {
    this.db.close();
  }

  registerHome({ homePath, alias = null, hostType = 'local', host = null, remotePort = null, remoteHome = null, remoteCmd = null, remoteLog = null, token = null, localPort = null, serverId = null, endpoints, activeEndpointId, accessPort }) {
    const homeId = homeIdOf(homePath);
    if (hostType !== 'remote' && normalizeAccessPort(accessPort) !== null) throw new Error('本机实例直接使用 dsh 服务端口，无需本地接入端口');
    if (accessPort !== undefined) accessPort = this.#checkAccessPort(homeId, accessPort);
    const previous = this.getHome(homeId);
    const supplied = endpoints !== undefined;
    const normalized = supplied ? normalizeEndpoints(endpoints, hostType) : null;
    if (supplied && activeEndpointId && !normalized.some((e) => e.id === activeEndpointId)) throw new Error('未知连接端点');

    // 新 home 排在末尾；已存在（冲突）只更新路径/别名/远程配置，保留原 sortIndex。
    const { n } = this.db.prepare('SELECT COALESCE(MAX(sortIndex), -1) + 1 AS n FROM homes').get();
    this.db.prepare(
      `INSERT INTO homes (homeId, homePath, alias, hostType, status, sortIndex, host, remotePort, remoteHome, remoteCmd, remoteLog, token, localPort)
       VALUES (?, ?, ?, ?, 'unknown', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(homeId) DO UPDATE SET
         homePath = excluded.homePath, alias = excluded.alias,
         hostType = excluded.hostType, host = excluded.host,
         remotePort = excluded.remotePort, remoteHome = excluded.remoteHome,
         remoteCmd = excluded.remoteCmd, remoteLog = excluded.remoteLog,
         token = excluded.token, localPort = excluded.localPort`
    ).run(homeId, homePath, alias, hostType, n, host, remotePort, remoteHome, remoteCmd, remoteLog, token, localPort);
    const choices = normalized ?? (previous?.endpoints?.length ? previous.endpoints.map((e) => e.id === previous.activeEndpointId ? { ...e, host, port: hostType === 'remote' ? remotePort : localPort, token } : e) : [legacyEndpoint({ homeId, hostType, host, remotePort, localPort, token })].filter(Boolean));
    if (choices.length || hostType === 'local') this.updateHomeConfig(homeId, { endpoints: choices, activeEndpointId: activeEndpointId || previous?.activeEndpointId || choices[0]?.id || null });
    if (serverId) this.db.prepare('UPDATE homes SET serverId = ? WHERE homeId = ?').run(serverId, homeId);
    if (accessPort !== undefined) this.db.prepare('UPDATE homes SET accessPort = ? WHERE homeId = ?').run(accessPort, homeId);
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

  // 注意：getHome 定义在下方 listHomes 附近（两者共用 HOME_SELECT）。
  // 这里原先还有一份 `getHome() { return this.listHomes().find(...) }`，改成点查时忘删 ——
  // JS 里后定义的会静默覆盖先定义的，所以行为是对的，但留着一份永不执行的旧实现极其危险：
  // 下次有人改上面那份会以为改的就是真正生效的那个。已删除。

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
    if (cur.hostType !== 'remote' && normalizeAccessPort(patch.accessPort) !== null) throw new Error('本机实例直接使用 dsh 服务端口，无需本地接入端口');
    if (patch.accessPort !== undefined) patch = { ...patch, accessPort: this.#checkAccessPort(homeId, patch.accessPort) };
    const choices = patch.endpoints !== undefined ? normalizeEndpoints(patch.endpoints, cur.hostType) : cur.endpoints;
    let selected = patch.activeEndpointId !== undefined ? patch.activeEndpointId : cur.activeEndpointId;
    if (patch.endpoints !== undefined && !choices.some((e) => e.id === selected)) selected = choices[0]?.id || null;
    if (selected && !choices.some((e) => e.id === selected)) throw new Error('未知连接端点');
    if (patch.endpoints !== undefined || patch.activeEndpointId !== undefined) {
      const endpoint = choices.find((e) => e.id === selected);
      patch = { ...patch, ...(endpoint ? endpointPatch(cur, endpoint) : { localPort: null }), endpoints: choices, activeEndpointId: selected };
    } else if (choices.length && ['host', 'remotePort', 'localPort', 'token'].some((key) => patch[key] !== undefined)) {
      const merged = { ...cur, ...patch };
      patch = { ...patch, endpoints: choices.map((e) => e.id === selected ? { ...e, host: merged.hostType === 'remote' ? merged.host : null, port: merged.hostType === 'remote' ? merged.remotePort : merged.localPort, token: merged.token } : e) };
      if (cur.hostType === 'local' && !merged.localPort) patch = { ...patch, endpoints: [], activeEndpointId: null };
      else patch.endpoints = normalizeEndpoints(patch.endpoints, cur.hostType);
    }

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

    if (patch.endpoints !== undefined) this.db.prepare('UPDATE homes SET endpoints = ? WHERE homeId = ?').run(JSON.stringify(patch.endpoints), homeId);
    if (patch.activeEndpointId !== undefined) this.db.prepare('UPDATE homes SET activeEndpointId = ? WHERE homeId = ?').run(patch.activeEndpointId, homeId);
    const cur2 = this.getHome(homeId);
    if (patch.serverId !== undefined) this.db.prepare('UPDATE homes SET serverId = ? WHERE homeId = ?').run(patch.serverId, homeId);
    if (patch.accessPort !== undefined) this.db.prepare('UPDATE homes SET accessPort = ? WHERE homeId = ?').run(patch.accessPort, homeId);
    const alias = patch.alias !== undefined ? patch.alias : cur2.alias;
    const host = patch.host !== undefined ? patch.host : cur2.host;
    const remotePort = patch.remotePort !== undefined ? patch.remotePort : cur2.remotePort;
    const remoteHome = patch.remoteHome !== undefined ? patch.remoteHome : cur2.remoteHome;
    const remoteCmd = patch.remoteCmd !== undefined ? patch.remoteCmd : cur2.remoteCmd;
    const remoteLog = patch.remoteLog !== undefined ? patch.remoteLog : cur2.remoteLog;
    const token = patch.token !== undefined ? patch.token : cur2.token;
    const localPort = patch.localPort !== undefined ? patch.localPort : cur2.localPort;
    this.db.prepare('UPDATE homes SET alias = ?, host = ?, remotePort = ?, localPort = ?, remoteHome = ?, remoteCmd = ?, remoteLog = ?, token = ? WHERE homeId = ?')
      .run(alias, host, remotePort, localPort, remoteHome, remoteCmd, remoteLog, token, homeId);
    return this.getHome(homeId);
  }

  #checkAccessPort(homeId, value) {
    const port = normalizeAccessPort(value);
    if (port && this.db.prepare('SELECT homeId FROM homes WHERE accessPort = ? AND homeId != ?').get(port, homeId)) {
      throw new Error(`本地端口 ${port} 已被另一个实例保留`);
    }
    return port;
  }

  // 记录「该实例索引失败」。它经常是从另一个 catch 里被调用的（indexer 的失败分支），
  // 所以**自己绝不能再抛**：数据库不可写时（文件被删、目录只读、磁盘满）二次异常会顶掉
  // 原始错误、让调用方的 catch 再次抛出，进而中断当轮剩下的所有实例。
  // 写失败只记日志；原始错误由调用方照常上报。
  markHomeError(homeId, error) {
    try {
      this.db.prepare(
        `UPDATE homes SET status = 'degraded',
         degraded = json_array(json_object('domain', 'index', 'error', ?, 'degraded', json('true')))
         WHERE homeId = ?`
      ).run(String(error), homeId);
    } catch (e) {
      log.warn('写入实例错误状态失败（数据库可能不可写）', { homeId, error: e?.message ?? String(e) });
    }
  }

  // Full-refresh per home: child rows for a home are replaced wholesale.
  //
  // 但「整表替换」遇上降级域会变成一个静默的数据清空：某个元数据文件的 unit.version
  // 超出支持范围时（dsh 升级后的必然情形），该域被判 degraded 并产出 0 行，
  // 照删不误就等于把上一次成功索引的内容删光 —— 用户在仪表盘上看到「这个实例的会话和项目全没了」，
  // 而界面上没有任何地方显示 degraded，完全无法归因。
  // 因此：某域降级时**跳过它对应的表的 DELETE**，保留上次成功的行；其余域照常刷新。
  upsertRows(rows) {
    const homeRows = rows.filter((r) => r.type === 'home');
    const preservedSessions = new Map(); // homeId -> Map(sessionId -> 上一版的 workspace 归属)
    const preservedLiveStatus = new Map(); // homeId -> [{sessionId,status,lastActivity}]（见下）
    const linkCleanupHomes = new Set();    // 需要清理悬空 workspace 归属的 home（见下）

    this.db.exec('BEGIN');
    try {
      for (const home of homeRows) {
        const protectedTables = degradedTables(home.degraded);
        // 跨表牵连：sessions 的 workspaceId/workspaceTitle/project 是从 workspace.json **推导**出来的
        // （normalize 反查 workspace.sessionIds）。workspace 域降级时 snapshot.workspaces 为空，
        // 新产出的会话行 workspaceId 全是 null —— 而 workspaces 表保留着旧行，于是会话与工作区断开：
        // sessionWorkspace() 直接返回 null，preview / download / upload 对一个完全正常的会话报
        // 「当前会话尚未关联可用的 project 工作区」，保留的 workspace 也变成孤儿。
        // 这里把上一版的归属回填到新行上（workspace 域恢复后会被新数据自然覆盖）。
        // 注意必须在下面的 DELETE **之前**读：workspace 降级时 sessions 本身仍会被替换掉。
        if (protectedTables.has('workspaces')) preservedSessions.set(home.homeId, this.#sessionWorkspaceLinks(home.homeId));
        // sessions 被保护（保留旧行）时，旧行里的 workspaceId 可能指向这次刷新后**已消失**的
        // workspace —— 那会让 sessionWorkspace() 返回 null，preview/upload 对完全正常的会话报
        // 「尚未关联可用的 project 工作区」。两种触发路径都要清理：workspaces 降级（链接是回填的）
        // 与 sessions 降级（链接是上一次索引留下的）。
        if (protectedTables.has('sessions') || protectedTables.has('workspaces')) linkCleanupHomes.add(home.homeId);
        // 实时状态保护：索引器写的是文件快照（projcache 的**冻结**值，可能是几分钟前的），
        // 而轮询器每 3s 写实时值。整表替换会把实时状态一起删掉再用文件值重建 ——
        // 于是「索引器刚跑完，徽标就退回陈旧状态」（实测：dsh 报 running、轮询器刚写「运行中」，
        // 索引器把它打回「空闲」）。只要这个 home 最近有实时写入，就在替换前记下这两列、替换后写回。
        // 只在实时通道**确实在写**的时间窗内让步：通道停了（实例停止、RPC 连续失败）就没有实时写入，
        // 宽限期一过文件索引重新拿到权威 —— 否则会退化成「会话永远挂着旧徽标」那个已修的缺陷。
        if (Date.now() - this.liveStatusAt(home.homeId) < LIVE_GRACE_MS) {
          const live = this.db.prepare('SELECT sessionId, status, lastActivity FROM sessions WHERE homeId = ? AND status IS NOT NULL').all(home.homeId);
          if (live.length) preservedLiveStatus.set(home.homeId, live);
        }
        for (const table of CHILD_TABLES) {
          if (protectedTables.has(table)) continue; // 该域降级 → 保留上次成功的行
          this.db.prepare(`DELETE FROM ${table} WHERE homeId = ?`).run(home.homeId);
        }
      }

      // 注意：不能用 `ON CONFLICT ... CASE` 来保护实时状态 —— 这条路径在插入之前就把该 home 的
      // sessions **整表删掉**了（见上面的 DELETE 循环），新行是**插入**而不是冲突更新，
      // ON CONFLICT 分支根本不会执行。实测确认过：加在 ON CONFLICT 里的保留逻辑是死代码。
      // 真正有效的做法是在替换前记下实时状态、替换后写回（见 preservedLiveStatus）。
      const insSession = this.db.prepare(
        `INSERT INTO sessions (homeId, sessionId, workspaceId, workspaceTitle, project, title, tokenUsage,
                               contextPressure, status, lastActivity, generatedAt, liveOnly)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(homeId, sessionId) DO UPDATE SET
           -- 「文件索引撑起来的行」不能被「只有实时 RPC 支撑的新行」抹掉。
           -- 触发条件：库里这行是 liveOnly=0（有文件索引依据），而这次写入的是 liveOnly=1
           -- （说明本次文件快照里没有这条会话 —— projcache 域降级、文件还没更新、或刚升级到
           -- 不认识的 unit.version，正是降级路径存在的原因）。
           -- 原先这种冲突会用 live 行的空值覆盖 title/workspaceId/project/tokenUsage，并把
           -- liveOnly 从 0 翻成 1：于是用量面板整段历史归零（实测 1520550 → 620550，
           -- 丢了 59%），会话丢掉标题与工作区归属；更要命的是翻成 1 之后，下一次「实时列表为空」
           -- 的轮询会把它**删掉**（那一分支专门删 liveOnly=1）。文件快照坏掉不该等于历史被删。
           -- 实时能提供的仍然是状态与活跃时间（这才是徽标要的），所以只保留这两列照旧覆盖。
           workspaceId=CASE WHEN sessions.liveOnly=0 AND excluded.liveOnly=1 THEN sessions.workspaceId ELSE excluded.workspaceId END,
           workspaceTitle=CASE WHEN sessions.liveOnly=0 AND excluded.liveOnly=1 THEN sessions.workspaceTitle ELSE excluded.workspaceTitle END,
           project=CASE WHEN sessions.liveOnly=0 AND excluded.liveOnly=1 THEN sessions.project ELSE excluded.project END,
           title=CASE WHEN sessions.liveOnly=0 AND excluded.liveOnly=1 THEN sessions.title ELSE excluded.title END,
           tokenUsage=CASE WHEN sessions.liveOnly=0 AND excluded.liveOnly=1 THEN sessions.tokenUsage ELSE excluded.tokenUsage END,
           contextPressure=CASE WHEN sessions.liveOnly=0 AND excluded.liveOnly=1 THEN sessions.contextPressure ELSE excluded.contextPressure END,
           status=excluded.status,
           lastActivity=excluded.lastActivity, generatedAt=excluded.generatedAt,
           liveOnly=CASE WHEN sessions.liveOnly=0 AND excluded.liveOnly=1 THEN 0 ELSE excluded.liveOnly END`
      );
      const insWorkspace = this.db.prepare(
        `INSERT INTO workspaces (homeId, workspaceId, title, path, project, archived, sessionCount)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      // ON CONFLICT 而不是裸 INSERT：providers 有 UNIQUE(homeId, ref)，而 ref 来自凭据/文件内容。
      // 上游已经按 ref 去重（read-home.parseCredentialsYaml），这里是第二道保险 ——
      // 一次约束冲突会让整个 upsertRows 事务回滚，该实例的会话/工作区一行都提交不了、
      // 状态永久 degraded 并每 60s 重试一次同样失败。
      const insProvider = this.db.prepare(
        `INSERT INTO providers (homeId, ref, provider) VALUES (?, ?, ?)
         ON CONFLICT(homeId, ref) DO UPDATE SET provider = excluded.provider`
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

      for (const rawRow of rows) {
        // 注意：这里不能靠「遍历键把 undefined 换成 null」—— 字段**整个缺失**时键根本不出现，
        // 那种行照样会把 undefined 绑给 SQLite 并抛「Provided value cannot be bound to SQLite
        // parameter N」，于是在事务里让该 home 的整批行回滚。所以下面每个绑定点都显式 `?? null`。
        const row = rawRow;
        switch (row?.type) {
          case 'home':
            upHome.run(
              row.homeId ?? null,
              row.homePath ?? null,
              (row.degraded ?? []).length === 0 ? 'ok' : 'degraded',
              row.generatedAt ?? null,
              JSON.stringify(row.degraded ?? [])
            );
            break;
          case 'session': {
            const link = row.workspaceId == null ? preservedSessions.get(row.homeId)?.get(row.sessionId) : null;
            insSession.run(
              row.homeId ?? null, row.sessionId ?? null,
              row.workspaceId ?? link?.workspaceId ?? null,
              row.workspaceTitle ?? link?.workspaceTitle ?? null,
              // project 同理：workspace 域降级时它退化成 basename(cwd)，回填上一版更准的值。
              link?.project ?? row.project ?? null,
              row.title ?? null, row.tokenUsage ?? null, row.contextPressure ?? null, row.status ?? null,
              row.lastActivity ?? null, row.generatedAt ?? null,
              row.liveOnly ? 1 : 0
            );
            break;
          }
          case 'workspace':
            insWorkspace.run(
              row.homeId ?? null, row.workspaceId ?? null, row.title ?? null, row.path ?? null,
              row.project ?? null, row.archived ? 1 : 0, row.sessionCount ?? null
            );
            break;
          case 'provider':
            insProvider.run(row.homeId ?? null, row.ref ?? null, row.provider ?? null);
            break;
          case 'modelTier':
            insTier.run(row.homeId ?? null, row.tierId ?? null, row.active ? 1 : 0, row.provider ?? null, row.model ?? null);
            break;
        }
      }
      // 把实时状态写回（替换期间被 DELETE 带走了）。新行里没有这条会话（文件快照里没有）也不用管：
      // 它要么是 liveOnly 行、由下一次轮询重建，要么本来就不该有。
      // 保留的 workspace 归属也可能已经悬空：workspace 域降级 + workspace.json 刷新后删掉了某个
      // workspace，而 sessions 行里还留着它的 id → sessionWorkspace() 返回 null，
      // preview/upload 会对一个完全正常的会话报「尚未关联可用的 project 工作区」。
      // 这里清理掉指向不存在 workspace 的归属（顺带也能修好库里既有的悬空链接）。
      for (const hid of linkCleanupHomes) {
        // EXISTS 那半句很重要：workspace.json 缺失/降级时该 home 一条 workspace 行都没有，
        // 那种情况下我们**并不掌握**工作区清单，不能凭「子查询里没有」就断定链接悬空
        // （否则会把本来正确的归属一并清掉）。只有确实有工作区数据时才做清理。
        this.db.prepare(
          `UPDATE sessions SET workspaceId = NULL, workspaceTitle = NULL
            WHERE homeId = ? AND workspaceId IS NOT NULL
              AND EXISTS (SELECT 1 FROM workspaces WHERE homeId = ?)
              AND workspaceId NOT IN (SELECT workspaceId FROM workspaces WHERE homeId = ?)`
        ).run(hid, hid, hid);
      }
      for (const [hid, list] of preservedLiveStatus) {
        const upd = this.db.prepare('UPDATE sessions SET status = ?, lastActivity = ? WHERE homeId = ? AND sessionId = ?');
        for (const r of list) upd.run(r.status, r.lastActivity, hid, r.sessionId);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      // 回滚本身失败时不要把真正的错误吞掉：磁盘满等情况下 SQLite 已经自动回滚，
      // 此时 ROLLBACK 会抛「cannot rollback - no transaction is active」，覆盖掉真实原因。
      try { this.db.exec('ROLLBACK'); } catch { /* 已经回滚过了 */ }
      throw e;
    }
  }

  // 实时刷新只写会话，保留 workspace/provider 等文件索引数据。
  //
  // live 为**空数组**是一次成功的读取、含义是「dsh 当前没有会话」——区别于读取失败（poller 传 null
  // 时根本不会走到这里）。原先空数组被直接 return，于是纯实时行（liveOnly=1，文件索引里还没有它）
  // 会一直留着：用户在 dsh 里关掉全部会话后，工作台仍显示上一个会话的「运行中」徽标，
  // 直到 60s 后的文件索引才纠正。现在按标记精确清掉这些行；有文件索引支撑的会话不受影响，
  // 它们的权威来源是文件索引，不该被实时列表的缺失误删。
  // 最近一次「实时状态写入」的时间戳（按 home）。索引器在抓实时状态前会记下时间，
  // 抓完如果发现这期间轮询器已经写过更新的数据，就丢弃自己这份（多半已经过期）。
  // 见 src/dshhome/indexer.js 里的守卫。
  liveStatusAt(homeId) {
    return this.#liveWrittenAt.get(homeId) ?? 0;
  }

  applyLiveStatus(homeId, live) {
    if (!this.getHome(homeId) || !Array.isArray(live)) return;
    if (!live.length) {
      this.db.prepare('DELETE FROM sessions WHERE homeId = ? AND liveOnly = 1').run(homeId);
      // 如果 projcache 域正降级，剩下的会话行是**上次成功索引**的冻结快照，谁也刷新不了它们
      // （整表替换被跳过）。此时 dsh 明确报告「没有会话」，那些行上的 status 就一定是陈旧的——
      // 用户会看到一个永远显示「运行中」的幽灵会话。清掉状态徽标（而不是删行）：UI 退回「空闲」，
      // 数据仍在，等 projcache 恢复后由文件索引覆盖。
      const home = this.getHome(homeId);
      if (degradedTables(home?.degraded).has('sessions')) {
        this.db.prepare('UPDATE sessions SET status = NULL WHERE homeId = ?').run(homeId);
      }
      return;
    }
    // 幽灵行清理：liveOnly=1 的行**只由实时列表支撑**，所以一旦它不在这次列表里，就该消失。
    // 原先只在「列表完全为空」那一分支清理，于是只要有任意一条会话还活着，先前消失的会话就会
    // 一直留在库里：永远显示「运行中」、占着 sessionCount、还会造出一个幻影项目 ——
    // 实测在实时列表里移除一条会话后，它整整 70 秒（直到下一轮文件索引）都还在，
    // 而在 projcache 降级时是**永久**的（文件索引永远覆盖不了它）。
    // 逐行删而不是 `sessionId NOT IN (...)`：实时列表可能有几千条，SQL 变量数有上限。
    const liveIds = new Set(live.map((l) => l?.sessionId).filter(Boolean));
    const ghosts = this.db.prepare('SELECT id, sessionId FROM sessions WHERE homeId = ? AND liveOnly = 1').all(homeId);
    if (ghosts.length) {
      const del = this.db.prepare('DELETE FROM sessions WHERE id = ?');
      for (const g of ghosts) if (!liveIds.has(g.sessionId)) del.run(g.id);
    }
    const rows = this.db.prepare('SELECT * FROM sessions WHERE homeId = ?').all(homeId)
      .map((row) => ({ ...row, type: 'session' }));
    this.upsertRows(mergeLiveStatus(rows, live, { homeId, generatedAt: new Date().toISOString() }));
    this.#liveWrittenAt.set(homeId, Date.now());
  }

  // 每个 home 的「当前项目/当前会话」——取最近活跃（lastActivity 最大）的 session 及其所属 workspace。
  // 这是 hwb 的「当前」语义：与 recentProjects/recentSessions（时间窗内聚合）不同，它是每个实例的单一当前项。
  #currentSession(homeId) {
    const r = this.db.prepare(
      `SELECT sessionId, workspaceId, workspaceTitle, project, title, tokenUsage, contextPressure, status, lastActivity
       FROM sessions WHERE homeId = ?
       ORDER BY (lastActivity IS NULL), lastActivity DESC, rowid DESC LIMIT 1`
    ).get(homeId);
    if (!r) return null;
    return {
      sessionId: r.sessionId,
      workspaceId: r.workspaceId,
      workspaceTitle: r.workspaceTitle,
      project: r.project,
      title: r.title ?? null,
      lastActivity: r.lastActivity,
      tokenUsage: safeJsonParse(r.tokenUsage, null, 'sessions.tokenUsage'),
      contextPressure: safeJsonParse(r.contextPressure, null, 'sessions.contextPressure'),
      status: safeJsonParse(r.status, null, 'sessions.status'),
    };
  }

  listHomes() {
    return this.db.prepare(`${HOME_SELECT} ORDER BY (h.sortIndex IS NULL), h.sortIndex, h.homeId`)
      .all()
      .map((h) => this.#enrichHome(h));
  }

  // 按 id 取单个实例。**不能**再用 listHomes().find(...)：listHomes 对每个实例都要跑
  // providers / activeTier / currentSession 三条语句加两次 JSON.parse，而实时轮询每约 3s 就会
  // 对每个实例多次调用 getHome —— 一个实例时无感，十几个实例时就是每轮十几毫秒的同步阻塞
  // （node:sqlite 是同步 API，直接卡住事件循环：SSE、HTTP、监控心跳一起等）。
  getHome(homeId) {
    if (!homeId) return null;
    const row = this.db.prepare(`${HOME_SELECT} WHERE h.homeId = ?`).get(homeId);
    return row ? this.#enrichHome(row) : null;
  }

  // 该 home 现有会话行的 workspace 归属（供 workspace 域降级时回填）。
  #sessionWorkspaceLinks(homeId) {
    const map = new Map();
    for (const row of this.db.prepare(
      'SELECT sessionId, workspaceId, workspaceTitle, project FROM sessions WHERE homeId = ?'
    ).all(homeId)) {
      map.set(row.sessionId, { workspaceId: row.workspaceId, workspaceTitle: row.workspaceTitle, project: row.project });
    }
    return map;
  }

  #enrichHome(h) {
    // 预编译语句懒初始化并复用：原先它们被提到 listHomes 的 map 之外，
    // 现在 getHome 也要用，所以挂到实例上（每个 store 实例生命周期内只 prepare 一次）。
    this.#providersStmt ??= this.db.prepare('SELECT homeId, ref, provider FROM providers WHERE homeId = ? ORDER BY provider');
    this.#tiersStmt ??= this.db.prepare(
      "SELECT homeId, tierId, provider, model FROM model_tiers WHERE homeId = ? AND active = 1 ORDER BY CASE WHEN tierId = 'default' THEN 0 ELSE 1 END"
    );
    return {
      ...h,
      endpoints: safeJsonParse(h.endpoints, [], 'homes.endpoints'),
      degraded: safeJsonParse(h.degraded, [], 'homes.degraded'),
      providers: this.#providersStmt.all(h.homeId),
      activeTier: this.#tiersStmt.get(h.homeId) ?? null,
      current: this.#currentSession(h.homeId),
    };
  }

  // Recent projects: cross-instance, active within `days`, ordered by last activity (§7.1).
  // 每个 project 附带"它所属的实例 + 该 project 最新会话"，供点击直接跳转。
  recentProjects({ days = 7, limit = 20, homeIds = null } = {}) {
    const since = daysAgoIso(days);
    const scope = homeIds === null ? null : JSON.stringify(homeIds);
    const projects = this.db.prepare(
      `WITH visible_sessions AS (
         SELECT * FROM sessions WHERE (? IS NULL OR homeId IN (SELECT value FROM json_each(?)))
       ) SELECT s.project,
              COUNT(*) AS sessionCount,
              MAX(s.lastActivity) AS lastActivity,
              SUM(s.tokInput + s.tokCacheRead + s.tokCacheWrite) AS inputTokens,
              SUM(s.tokOutput) AS outputTokens,
              (SELECT x.homeId FROM visible_sessions x WHERE x.project = s.project
                 ORDER BY x.lastActivity DESC, x.id DESC LIMIT 1) AS homeId,
              (SELECT x.sessionId FROM visible_sessions x WHERE x.project = s.project
                 ORDER BY x.lastActivity DESC, x.id DESC LIMIT 1) AS sessionId,
              (SELECT x.workspaceId FROM visible_sessions x WHERE x.project = s.project
                 ORDER BY x.lastActivity DESC, x.id DESC LIMIT 1) AS workspaceId
       FROM visible_sessions s
       WHERE s.project IS NOT NULL AND s.lastActivity IS NOT NULL AND s.lastActivity >= ?
       GROUP BY s.project
       ORDER BY s.lastActivity DESC
       LIMIT ${int(limit, 20)}`
    ).all(scope, scope, since);

    // Workspaces with no sessions still show up as projects (§4.5) — 跳到其所属实例，
    // 无最新会话，sessionId 为 null。
    const orphanWs = this.db.prepare(
      `SELECT w.project AS project, 0 AS sessionCount, NULL AS lastActivity,
              0 AS inputTokens, 0 AS outputTokens,
              w.homeId AS homeId, NULL AS sessionId, w.workspaceId AS workspaceId
       FROM workspaces w
       WHERE (? IS NULL OR w.homeId IN (SELECT value FROM json_each(?))) AND w.archived = 0 AND NOT EXISTS (
         SELECT 1 FROM sessions s WHERE s.homeId = w.homeId AND s.workspaceId = w.workspaceId
       )`
    ).all(scope, scope);
    const seen = new Set(projects.map((p) => p.project));
    for (const w of orphanWs) {
      if (!seen.has(w.project)) projects.push(w);
    }
    return projects.slice(0, int(limit, 20));
  }

  getSession(homeId, sessionId) {
    return this.db.prepare('SELECT sessionId, workspaceId, project FROM sessions WHERE homeId = ? AND sessionId = ?').get(homeId, sessionId) || null;
  }

  recentSessions({ homeId = null, limit = 50, homeIds = null } = {}) {
    const scope = homeIds === null ? null : JSON.stringify(homeIds);
    const where = 'WHERE (? IS NULL OR homeId IN (SELECT value FROM json_each(?))) AND (? IS NULL OR homeId = ?)';
    const args = [scope, scope, homeId, homeId];
    return this.db.prepare(
      `SELECT homeId, sessionId, workspaceId, workspaceTitle, project, title, tokenUsage, contextPressure, status, lastActivity
       FROM sessions ${where}
       ORDER BY lastActivity DESC NULLS LAST
       LIMIT ${int(limit, 50)}`
    ).all(...args).map((s) => ({
      ...s,
      tokenUsage: safeJsonParse(s.tokenUsage, null, 'sessions.tokenUsage'),
      contextPressure: safeJsonParse(s.contextPressure, null, 'sessions.contextPressure'),
      status: safeJsonParse(s.status, null, 'sessions.status'),
    }));
  }

  // ⚠️ 两个「输入」口径不同，别把它们当成同一个数：
  //   · usageSummary/usageTrend/... 的 inputTokens = **新增输入**（tokInput，不含缓存）
  //   · recentProjects 的 inputTokens = **总输入**（tokInput + tokCacheRead + tokCacheWrite）
  // 同一条会话实测 1000 vs 1950。前者与用量卡片的分项对齐，后者是「这个项目一共消耗了多少输入」
  // （项目卡片就是按这个排序的）。界面上标签已写明（项目卡片 in 的 title 提示含缓存）。

  // Token 用量汇总（基于会话聚合 tokenUsage）：总 Tokens / 输入 / 输出 / 缓存命中 / 缓存创建 / 缓存命中率。
  usageSummary({ days = 30 } = {}) {
    const since = daysAgoIso(days);
    const r = this.db.prepare(
      `SELECT
         COUNT(*) AS sessionCount,
         ${TOK.input} AS inputTokens,
         ${TOK.output} AS outputTokens,
         ${TOK.cacheRead} AS cacheRead,
         ${TOK.cacheWrite} AS cacheWrite,
         ${TOK.total} AS totalTokens
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

  // 分时用量趋势：按小时分桶（最后 `hours` 个整小时），填充空白桶使图表连续。
  usageTrend({ hours = 24 } = {}) {
    const now = Date.now();
    // 桶范围必须**包含当前这一小时**：原实现只列到 `floor(now/H) - 1` —— 当前这一小时的数据
    // 被 SQL 选出来了却没有桶可放，于是被静默丢掉（实测真实库 24h 窗口里丢了 3.5% 的 token，
    // 全部落在当前小时）。同时改为从旧到新（与 usageTrendGrouped 一致，图表不该反着画）。
    const endHour = Math.floor(now / 3_600_000);
    const startHour = endHour - hours + 1;
    // SQL 窗口必须与**桶的范围**完全重合（这是 usageTrendGrouped 的做法）。
    // 原实现写 `now - hours * 3600_000`：它比首个桶的起点更早（早 H - (now mod H)），
    // 于是那一小段「落在窗口里、却没有桶可放」的行被查出来又丢掉 —— 白查一趟，
    // 而且两条趋势口径在同一条边界上悄悄不一致。改成对齐后，取出的每一行都必定有桶。
    const startIso = new Date(startHour * 3_600_000).toISOString();
    const rows = this.db.prepare(
      // 与 usageTrendGrouped 同样的夹取：lastActivity 在未来（远端时钟偏）时，原先它的桶号超出
      // [startHour, endHour]，于是汇总算了、趋势图整条丢掉（实测 summary 6000 / trend 0）。
      // STRFTIME 解析不出来（脏时间戳）同样兜到最后一只桶。
      `SELECT COALESCE(MIN(CAST(STRFTIME('%s', lastActivity) / 3600 AS INTEGER), ?), ?) AS h,
              ${TOK.input} AS inputTokens,
              ${TOK.output} AS outputTokens,
              ${TOK.cacheRead} AS cacheRead,
              ${TOK.cacheWrite} AS cacheWrite
       FROM sessions
       WHERE lastActivity IS NOT NULL AND lastActivity >= ?
       GROUP BY h`
    ).all(endHour, endHour, startIso);
    const byH = new Map(rows.map((r) => [r.h, r]));
    const buckets = [];
    for (let h = startHour; h <= endHour; h++) {
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
    const since = daysAgoIso(days);
    return this.db.prepare(
      `SELECT project,
              COUNT(*) AS sessionCount,
              ${TOK.total} AS tokens
       FROM sessions
       WHERE project IS NOT NULL AND lastActivity IS NOT NULL AND lastActivity >= ?
       GROUP BY project
       ORDER BY tokens DESC
       LIMIT ${int(limit, 15)}`
    ).all(since);
  }

  // 分维度（total|project|instance|provider|model）、按周期自适应粒度的 token 聚合，供堆叠柱状图。
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
        : dimension === 'model'
          ? `COALESCE(
               (SELECT NULLIF(model, '') FROM model_tiers t
                 WHERE t.homeId = s.homeId AND t.active = 1
                 ORDER BY CASE WHEN t.tierId = 'default' THEN 0 ELSE 1 END LIMIT 1),
               'unknown')`
          : dimension === 'total'
            ? "'合计'"
            : `COALESCE(s.project, '(未分类)')`;
    const rows = this.db.prepare(
      // MIN(..., endBucket)：lastActivity 在**未来**（远端时钟偏、或 dsh 写了将来时间）时，
      // 原先它的桶号超出 [startBucket, endBucket]，于是用量汇总把它算进去了、趋势图却整条丢掉
      // （实测：summary 6000 / trend 1000）。夹到最后一只桶之后两边口径一致。
      // STRFTIME 解析不出来时返回 NULL，同样落进最后一只桶（MIN 忽略 NULL 的语义在这里不合适，
      // 所以用 COALESCE 兜到 endBucket）。
      `SELECT COALESCE(MIN(CAST(STRFTIME('%s', s.lastActivity) / ? AS INTEGER), ?), ?) AS h,
              ${groupExpr} AS grp,
              COALESCE(SUM(s.tokInput + s.tokOutput + s.tokCacheRead + s.tokCacheWrite), 0) AS tokens
       FROM sessions s
       WHERE s.lastActivity IS NOT NULL AND s.lastActivity >= ?
       GROUP BY h, grp
       ORDER BY h, tokens DESC`
    ).all(stepSec, endBucket, endBucket, startIso);

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
    // 标签必须**唯一**：图上每个分组是一张图例，同名的两条会被合并成一条。
    // `basename(homePath)` 撞名很常见 —— dsh 默认 home 目录就叫 `.dsh`，两个实例
    // （各自用户目录下）会都叫 `.dsh`：实测 1000 + 7000 被画成一条 `.dsh: 8000`。
    // 撞名时补一段 homeId 前缀，让用户能区分（而不是让数字悄悄合到一起）。
    const used = new Set();
    for (const h of homes) {
      const base = (h.alias && String(h.alias).trim()) || (h.homePath ? path.basename(h.homePath) : h.homeId);
      let label = base;
      if (used.has(label)) label = `${base} (${h.homeId.slice(0, 6)})`;
      let n = 2;
      while (used.has(label)) label = `${base} (${h.homeId.slice(0, 6)}-${n++})`;
      used.add(label);
      m.set(h.homeId, label);
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
