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
    if (!sess.includes('liveOnly')) {
      // 已有库里的行都来自文件索引或早期实时合并：默认 0 最保守（不会被空实时列表误删）。
      this.db.exec('ALTER TABLE sessions ADD COLUMN liveOnly INTEGER NOT NULL DEFAULT 0');
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
    if (!homes.includes('localPort')) {
      this.db.exec('ALTER TABLE homes ADD COLUMN localPort INTEGER');
    }
    if (!homes.includes('accessPort')) this.db.exec('ALTER TABLE homes ADD COLUMN accessPort INTEGER');
    this.db.exec("UPDATE homes SET accessPort = NULL WHERE hostType != 'remote' AND accessPort IS NOT NULL");
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
        for (const table of CHILD_TABLES) {
          if (protectedTables.has(table)) continue; // 该域降级 → 保留上次成功的行
          this.db.prepare(`DELETE FROM ${table} WHERE homeId = ?`).run(home.homeId);
        }
      }

      const insSession = this.db.prepare(
        `INSERT INTO sessions (homeId, sessionId, workspaceId, workspaceTitle, project, title, tokenUsage, contextPressure, status, lastActivity, generatedAt, liveOnly)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(homeId, sessionId) DO UPDATE SET
           workspaceId=excluded.workspaceId, workspaceTitle=excluded.workspaceTitle,
           project=excluded.project, title=excluded.title, tokenUsage=excluded.tokenUsage,
           contextPressure=excluded.contextPressure, status=excluded.status,
           lastActivity=excluded.lastActivity, generatedAt=excluded.generatedAt,
           liveOnly=excluded.liveOnly`
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
          case 'session': {
            const link = row.workspaceId == null ? preservedSessions.get(row.homeId)?.get(row.sessionId) : null;
            insSession.run(
              row.homeId, row.sessionId,
              row.workspaceId ?? link?.workspaceId ?? null,
              row.workspaceTitle ?? link?.workspaceTitle ?? null,
              // project 同理：workspace 域降级时它退化成 basename(cwd)，回填上一版更准的值。
              link?.project ?? row.project,
              row.title ?? null, row.tokenUsage, row.contextPressure, row.status, row.lastActivity, row.generatedAt,
              row.liveOnly ? 1 : 0
            );
            break;
          }
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

  // 实时刷新只写会话，保留 workspace/provider 等文件索引数据。
  //
  // live 为**空数组**是一次成功的读取、含义是「dsh 当前没有会话」——区别于读取失败（poller 传 null
  // 时根本不会走到这里）。原先空数组被直接 return，于是纯实时行（liveOnly=1，文件索引里还没有它）
  // 会一直留着：用户在 dsh 里关掉全部会话后，工作台仍显示上一个会话的「运行中」徽标，
  // 直到 60s 后的文件索引才纠正。现在按标记精确清掉这些行；有文件索引支撑的会话不受影响，
  // 它们的权威来源是文件索引，不该被实时列表的缺失误删。
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
    const rows = this.db.prepare('SELECT * FROM sessions WHERE homeId = ?').all(homeId)
      .map((row) => ({ ...row, type: 'session' }));
    this.upsertRows(mergeLiveStatus(rows, live, { homeId, generatedAt: new Date().toISOString() }));
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
              SUM(COALESCE(json_extract(s.tokenUsage, '$.uncachedInputTokens'), 0)
                + COALESCE(json_extract(s.tokenUsage, '$.cacheReadTokens'), 0)
                + COALESCE(json_extract(s.tokenUsage, '$.cacheWriteTokens'), 0)) AS inputTokens,
              SUM(COALESCE(json_extract(s.tokenUsage, '$.outputTokens'), 0)) AS outputTokens,
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

  // Token 用量汇总（基于会话聚合 tokenUsage）：总 Tokens / 输入 / 输出 / 缓存命中 / 缓存创建 / 缓存命中率。
  usageSummary({ days = 30 } = {}) {
    const since = daysAgoIso(days);
    const r = this.db.prepare(
      `SELECT
         COUNT(*) AS sessionCount,
         COALESCE(SUM(json_extract(tokenUsage, '$.uncachedInputTokens')), 0) AS inputTokens,
         COALESCE(SUM(json_extract(tokenUsage, '$.outputTokens')), 0) AS outputTokens,
         COALESCE(SUM(json_extract(tokenUsage, '$.cacheReadTokens')), 0) AS cacheRead,
         COALESCE(SUM(json_extract(tokenUsage, '$.cacheWriteTokens')), 0) AS cacheWrite,
         COALESCE(SUM(COALESCE(json_extract(tokenUsage, '$.uncachedInputTokens'), 0)
                 + COALESCE(json_extract(tokenUsage, '$.outputTokens'), 0)
                 + COALESCE(json_extract(tokenUsage, '$.cacheReadTokens'), 0)
                 + COALESCE(json_extract(tokenUsage, '$.cacheWriteTokens'), 0)), 0) AS totalTokens
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
    // 桶范围必须**包含当前这一小时**：SQL 的窗口是 `lastActivity >= now - hours`，
    // 而原实现只列到 `floor(now/H) - 1` —— 当前这一小时的数据被 SQL 选出来了却没有桶可放，
    // 于是被静默丢掉（实测真实库 24h 窗口里丢了 3.5% 的 token，全部落在当前小时）。
    // 同时改为从旧到新的顺序（与 usageTrendGrouped 一致，图表不该反着画）。
    const endHour = Math.floor(now / 3_600_000);
    const startHour = endHour - hours + 1;
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
              COALESCE(SUM(COALESCE(json_extract(tokenUsage, '$.uncachedInputTokens'), 0)
                      + COALESCE(json_extract(tokenUsage, '$.outputTokens'), 0)
                      + COALESCE(json_extract(tokenUsage, '$.cacheReadTokens'), 0)
                      + COALESCE(json_extract(tokenUsage, '$.cacheWriteTokens'), 0)), 0) AS tokens
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
