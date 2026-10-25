// dsh-hwb-open-session — Host 半
//
// 为什么需要它：DSH 桌面端注册了 `dsh://`，但 `open-url` 只处理精确的
// `dsh://open`（聚焦窗口），没有「打开某个会话」的外部入口；dsh web 也没有
// `--session` 启动参数。也就是说，**外部进程无法让运行中的 DSH 切到某个会话**。
//
// 本插件补上这条「信使」通道，且不需要改 dsh 上游：
//   · hwb 原子写入 `<DSH_HOME>/hwb/open-session.json`（{id, sessionId, createdAt, expiresAt}）；
//   · 本插件的 Host 半在本机 webServer 上暴露只读路由 GET /api/hwb-open-session，
//     把未过期的触发器原样返回；
//   · Client 半（lib/client.js）每 ~1s 轮询该路由，发现新 id 就调用
//     ctx.sessions.open(sessionId)，并记住已处理的 id，避免刷新后重复打开。
//
// 安全：
//   · 路由只读，不接受任何写操作；触发器路径由部署配置决定，不来自请求。
//   · sessionId 只接受白名单字符（1–200），过期/损坏/缺字段一律按「没有触发器」处理。
//   · 触发器在用户自己的 home 目录（0700），同机其他用户不可写。

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const name = 'dsh-hwb-open-session';
export const inject = ['webServer'];

export const ROUTE = '/api/hwb-open-session';
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const MAX_TRIGGER_BYTES = 8 * 1024;

/** 触发器文件默认位置；config.triggerPath 可覆盖（自定义 DSH_HOME 的部署用）。 */
export function triggerPath(config = {}) {
  if (typeof config?.triggerPath === 'string' && config.triggerPath.trim() !== '') {
    return path.resolve(config.triggerPath);
  }
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'hwb', 'open-session.json');
}

/**
 * 读取并校验触发器。任何异常/过期/形状不符都返回 null —— 调用方按「无触发器」处理，
 * 不让一个坏文件把轮询路由变成 500。
 */
export async function readTrigger(file, { now = Date.now() } = {}) {
  let raw;
  try {
    raw = await readFile(file);
  } catch {
    return null;
  }
  if (raw.byteLength > MAX_TRIGGER_BYTES) return null;
  let data;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  if (typeof data.id !== 'string' || data.id === '' || data.id.length > 200) return null;
  if (typeof data.sessionId !== 'string' || !SESSION_ID_RE.test(data.sessionId)) return null;
  const expiresAt = Number(data.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return { ok: true, id: data.id, sessionId: data.sessionId, expiresAt };
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function apply(ctx, config = {}) {
  const webServer = ctx.webServer;
  if (webServer === undefined) return; // 不是 web 组合（例如 headless）：静默不挂路由
  const file = triggerPath(config);

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        const trigger = await readTrigger(file);
        writeJson(res, 200, trigger ?? { ok: false });
      } catch {
        // 任何异常都只影响这一次轮询：给 200 + ok:false，让客户端下一轮继续。
        try { writeJson(res, 200, { ok: false }); } catch { /* 连接已断 */ }
      }
    },
  }), `dsh-hwb-open-session: GET ${ROUTE}`);

  ctx.logger?.info?.(`dsh-hwb-open-session: watching ${file}`);
}
