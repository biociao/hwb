import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  validateWorkspaceJson,
  validateProjcacheJson,
  validateModelTierJson,
  validateCredentials,
} from './schema.js';

const PROVIDER_ALIASES = {
  kimi_code: 'kimi',
  minimax_cn: 'minimax',
};

export function homeIdOf(homePath) {
  return createHash('sha256').update(homePath).digest('hex').slice(0, 16);
}

// Minimal YAML parser: flat "KEY: value" lines plus the real dsh layout,
// where keys live indented under a top-level "refs:" block. Values are
// discarded except for emptiness — we only extract provider names (§4.1).
export function parseCredentialsYaml(text) {
  const providers = [];
  const seen = new Set(); // 按 ref 去重（见下）
  let inRefs = false;
  // 去掉 UTF-8 BOM：`\s` 在 JS 里匹配 U+FEFF，于是带 BOM 的 `\uFEFFrefs:` 会走 else 分支、
  // inRefs 永远为 false，缩进的所有 key 全被跳过 —— 一个被 BOM-adding 编辑器重存过的
  // 凭据文件会表现为「这个 home 没有任何 provider」。必须在切行之前剥掉。
  for (const raw of String(text ?? '').replace(/^\uFEFF/, '').split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      inRefs = /^refs\s*:\s*$/.test(raw.trim());
      if (inRefs) continue;
    } else if (!inRefs) {
      continue;
    }
    const m = raw.trim().match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, ref, value] = m;
    if (!ref.endsWith('_API_KEY')) continue;
    if (!value || value.startsWith('#')) continue;
    const base = ref.slice(0, -'_API_KEY'.length).toLowerCase();
    // **按 ref 去重**：providers 表是 UNIQUE(homeId, ref)，而且插入用的是普通 INSERT。
    // 一个被手工追加/编辑器重排过的凭据文件里出现两行同名 key，就会让整个 upsertRows 事务
    // 撞 UNIQUE 约束并回滚 —— 该实例的会话/工作区一行都提交不了，状态永久 degraded，
    // 每 60s 重试一次同样失败。这里取**最后一条**（与 readCredentials 的 Map 语义一致）。
    if (seen.has(ref)) {
      const at = providers.findIndex((p) => p.ref === ref);
      providers[at] = { ref, provider: PROVIDER_ALIASES[base] ?? base };
      continue;
    }
    seen.add(ref);
    providers.push({ ref, provider: PROVIDER_ALIASES[base] ?? base });
  }
  return providers;
}

// dsh 存储文件的统一读取抽象：本地用 fs（readHome），远程用 SSH cat（remote-reader）。
// `readText(relPath)` 返回文件文本（缺失时抛错，对应本地 ENOENT）；`exists(relPath)` 判断可选文件是否在。
// 二者决定哪个域的 degraded 判定与本地逐文件读取行为完全一致（§4.2/4.3）。
export function buildSnapshot({ homePath, readText, exists }) {
  const degraded = [];
  const snapshot = {
    homeId: homeIdOf(homePath),
    homePath,
    generatedAt: new Date().toISOString(),
    wsVersion: null,
    pcVersion: null,
    workspaces: [],
    sessions: [],
    modelTier: null,
    providers: [],
    degraded,
  };
  const readJson = (rel) => JSON.parse(readText(rel));

  try {
    const v = validateWorkspaceJson(readJson('storages/workspace.json'));
    if (v.ok) {
      snapshot.wsVersion = v.version;
      snapshot.workspaces = v.workspaces;
    } else {
      degraded.push({ domain: 'workspace', error: v.error, degraded: true });
    }
  } catch (e) {
    degraded.push({ domain: 'workspace', error: e.message, degraded: true });
  }

  try {
    const v = validateProjcacheJson(readJson('storages/session_projcache.json'));
    if (v.ok) {
      snapshot.pcVersion = v.version;
      snapshot.sessions = v.sessions;
    } else {
      degraded.push({ domain: 'projcache', error: v.error, degraded: true });
    }
  } catch (e) {
    degraded.push({ domain: 'projcache', error: e.message, degraded: true });
  }

  // model-tier.json 是可选的：未配置模型分层的 dsh home 没有此文件。
  // 缺失 → 保持 modelTier=null，不判定 degraded；存在但校验失败（版本/结构）→ degraded。
  if (exists('model-tier.json')) {
    try {
      const v = validateModelTierJson(readJson('model-tier.json'));
      if (v.ok) {
        snapshot.modelTier = v.modelTier;
      } else {
        degraded.push({ domain: 'modelTier', error: v.error, degraded: true });
      }
    } catch (e) {
      degraded.push({ domain: 'modelTier', error: e.message, degraded: true });
    }
  }

  // .credentials.yaml 是可选的：未配置 provider key 时缺失。
  // 缺失 → providers=[]，不判定 degraded。
  if (exists('.credentials.yaml')) {
    try {
      const v = validateCredentials(parseCredentialsYaml(readText('.credentials.yaml')));
      if (v.ok) {
        snapshot.providers = v.providers;
      } else {
        degraded.push({ domain: 'credentials', error: v.error, degraded: true });
      }
    } catch (e) {
      degraded.push({ domain: 'credentials', error: e.message, degraded: true });
    }
  }

  return snapshot;
}

export function readHome(homePath) {
  return buildSnapshot({
    homePath,
    readText: (rel) => readFileSync(path.join(homePath, rel), 'utf8'),
    exists: (rel) => existsSync(path.join(homePath, rel)),
  });
}
