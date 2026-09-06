import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

async function readJsonBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (raw.length > 64 * 1024) throw new Error('body too large');
  return raw ? JSON.parse(raw) : {};
}

function dshHomeInfo(homePath) {
  const exists = existsSync(homePath) && statSync(homePath).isDirectory();
  return {
    path: homePath,
    exists,
    looksLikeDshHome: exists && existsSync(path.join(homePath, 'storages', 'workspace.json')),
  };
}

export function createRouter({ store, indexer, hub, launcher, monitor, quota, logApi }) {
  return async function route(req, res, url) {
    const { pathname, searchParams } = url;

    if (req.method === 'GET' && pathname === '/api/events') {
      hub.handle(req, res);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/homes') {
      const homes = store.listHomes().map((h) => ({ ...h, runtime: monitor.get(h.homeId) }));
      send(res, 200, { homes });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/homes/detect') {
      send(res, 200, dshHomeInfo(path.join(homedir(), '.dsh')));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/homes') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        send(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const alias = typeof body.alias === 'string' && body.alias.trim() ? body.alias.trim() : null;

      // SSH 远程实例：host + remotePort（远端 dsh web 监听端口）。
      if (body.hostType === 'remote' || (body.host && body.remotePort)) {
        const host = typeof body.host === 'string' && body.host.trim() ? body.host.trim() : null;
        const remotePort = Number(body.remotePort);
        if (!host || !Number.isInteger(remotePort) || remotePort <= 0) {
          send(res, 400, { error: 'remote instance requires a non-empty host and a numeric remotePort' });
          return;
        }
        const remoteHome = typeof body.remoteHome === 'string' && body.remoteHome.trim() ? body.remoteHome.trim() : null;
        const remoteCmd = typeof body.remoteCmd === 'string' && body.remoteCmd.trim() ? body.remoteCmd.trim() : null;
        const remoteLog = typeof body.remoteLog === 'string' && body.remoteLog.trim() ? body.remoteLog.trim() : null;
        // 手填 token（自服务直连）：用户已更新远端 dsh 后把 token 填进配置，hwb 直接连接。
        const token = typeof body.token === 'string' && body.token.trim() ? body.token.trim() : null;
        const homePath = `ssh://${host}:${remotePort}`;
        const homeId = store.registerHome({ homePath, alias, hostType: 'remote', host, remotePort, remoteHome, remoteCmd, remoteLog, token });
        // 注册后立即触发一次该实例的索引（不等结果：远程走 SSH，不可达时要等超时，
        // 同步等待会卡住注册响应；索引完成后会广播 index:updated，前端经 SSE 自动刷新）。
        indexer.reindexNow(homeId);
        send(res, 200, { homeId, warning: null, result: null });
        return;
      }

      // 本地实例：homePath 必须存在。
      const homePath = typeof body.homePath === 'string' ? path.resolve(body.homePath.trim()) : null;
      if (!homePath) {
        send(res, 400, { error: 'homePath is required' });
        return;
      }
      const info = dshHomeInfo(homePath);
      if (!info.exists) {
        send(res, 400, { error: `not a directory: ${homePath}` });
        return;
      }
      // 本机 dsh web 端口（直连已有实例，可选）+ 手填 token：都有值时「打开」直接接入该实例而非新拉起。
      const lp = body.localPort;
      const localPort = (lp === '' || lp == null) ? null : (Number.isInteger(Number(lp)) && Number(lp) > 0 ? Number(lp) : null);
      const token = typeof body.token === 'string' && body.token.trim() ? body.token.trim() : null;
      const homeId = store.registerHome({ homePath, alias, hostType: 'local', localPort, token });
      const results = await indexer.reindexNow(homeId);
      send(res, info.looksLikeDshHome ? 200 : 202, {
        homeId,
        warning: info.looksLikeDshHome ? null : 'directory does not look like a dsh home (storages/workspace.json missing)',
        result: results[0] ?? null,
      });
      return;
    }
    const delHome = pathname.match(/^\/api\/homes\/([0-9a-f]{16})$/);
    if (req.method === 'PUT' && delHome) {
      const home = store.getHome(delHome[1]);
      if (!home) {
        send(res, 404, { error: `unknown homeId ${delHome[1]}` });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        send(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const patch = {};
      if (typeof body.alias === 'string') patch.alias = body.alias.trim() || null;
      if (home.hostType === 'local') {
        // 本地实例：允许改 homePath（须存在）。
        if (typeof body.homePath === 'string' && body.homePath.trim()) {
          const hp = path.resolve(body.homePath.trim());
          const info = dshHomeInfo(hp);
          if (!info.exists) {
            send(res, 400, { error: `not a directory: ${hp}` });
            return;
          }
          patch.homePath = hp;
        }
        // 本机直连端口 + token：配置了 localPort 则「打开」接入已有实例；为空则回到「新拉起」。
        if (body.localPort !== undefined) {
          const lp = body.localPort;
          patch.localPort = (lp === '' || lp == null) ? null : (Number.isInteger(Number(lp)) && Number(lp) > 0 ? Number(lp) : null);
        }
        if (body.token !== undefined) patch.token = typeof body.token === 'string' ? body.token.trim() || null : null;
      } else if (home.hostType === 'remote') {
        if (body.host !== undefined) {
          if (typeof body.host !== 'string' || !body.host.trim()) {
            send(res, 400, { error: 'host is required for remote instance' });
            return;
          }
          patch.host = body.host.trim();
        }
        if (body.remotePort !== undefined) {
          const p = Number(body.remotePort);
          if (!Number.isInteger(p) || p <= 0) {
            send(res, 400, { error: 'remotePort must be a positive integer' });
            return;
          }
          patch.remotePort = p;
        }
        if (typeof body.remoteHome === 'string') patch.remoteHome = body.remoteHome.trim() || null;
        if (body.remoteCmd !== undefined) patch.remoteCmd = typeof body.remoteCmd === 'string' ? body.remoteCmd.trim() || null : null;
        if (body.remoteLog !== undefined) patch.remoteLog = typeof body.remoteLog === 'string' ? body.remoteLog.trim() || null : null;
        // 手填 token：允许清空（''→null）以回到「远端抓取 / 自动启动」的流程。
        if (body.token !== undefined) patch.token = typeof body.token === 'string' ? body.token.trim() || null : null;
      }
      const updated = store.updateHomeConfig(home.homeId, patch);
      send(res, 200, { home: { ...updated, runtime: monitor.get(home.homeId) } });
      return;
    }
    if (req.method === 'DELETE' && delHome) {
      const homeId = delHome[1];
      if (!store.getHome(homeId)) {
        send(res, 404, { error: `unknown homeId ${homeId}` });
        return;
      }
      store.removeHome(homeId);
      hub.broadcast('index:updated', { homeId, removed: true });
      send(res, 200, { ok: true, homeId });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/homes/order') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        send(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const ids = Array.isArray(body.homeIds) ? body.homeIds : null;
      if (!ids || !ids.every((id) => typeof id === 'string' && store.getHome(id))) {
        send(res, 400, { error: 'homeIds must be a non-empty array of known homeIds' });
        return;
      }
      store.setHomeOrder(ids);
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/projects/recent') {
      send(res, 200, {
        projects: store.recentProjects({
          days: Number(searchParams.get('days')) || 7,
          limit: Number(searchParams.get('limit')) || 20,
        }),
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/sessions/recent') {
      send(res, 200, {
        sessions: store.recentSessions({
          homeId: searchParams.get('homeId') || null,
          limit: Number(searchParams.get('limit')) || 50,
        }),
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/workspaces') {
      send(res, 200, {
        workspaces: store.listWorkspaces({ homeId: searchParams.get('homeId') || null }),
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/usage') {
      const days = Math.min(Math.max(Number(searchParams.get('days')) || 30, 1), 365);
      // hours 支持到 30 天（24 * 30 = 720），对应「过去 30 天」统计周期。
      const hours = Math.min(Math.max(Number(searchParams.get('hours')) || 24, 1), 24 * 30);
      send(res, 200, {
        summary: store.usageSummary({ days }),
        trend: store.usageTrend({ hours }),
        byProject: store.usageByProject({ days }),
        trendBy: {
          total: store.usageTrendGrouped({ dimension: 'total', hours }),
          project: store.usageTrendGrouped({ dimension: 'project', hours }),
          instance: store.usageTrendGrouped({ dimension: 'instance', hours }),
          provider: store.usageTrendGrouped({ dimension: 'provider', hours }),
          model: store.usageTrendGrouped({ dimension: 'model', hours }),
        },
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/logs') {
      // 日志区域：返回环缓冲中（可按最低级别过滤）的最近日志。
      const level = searchParams.get('level') || undefined;
      const limit = Math.min(Math.max(Number(searchParams.get('limit')) || 200, 1), 1000);
      send(res, 200, { logs: logApi.getLogs({ level, limit }) });
      return;
    }

    const reindex = pathname.match(/^\/api\/homes\/([0-9a-f]{16})\/reindex$/);
    if (req.method === 'POST' && reindex) {
      const homeId = reindex[1];
      if (!store.getHome(homeId)) {
        send(res, 404, { error: `unknown homeId ${homeId}` });
        return;
      }
      const results = await indexer.reindexNow(homeId);
      send(res, 200, { results });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/quota') {
      send(res, 200, { quota: quota.list() });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/quota/refresh') {
      send(res, 200, { quota: await quota.refresh() });
      return;
    }

    const openHome = pathname.match(/^\/api\/homes\/([0-9a-f]{16})\/open$/);
    if (req.method === 'POST' && openHome) {
      const home = store.getHome(openHome[1]);
      if (!home) {
        send(res, 404, { error: `unknown homeId ${openHome[1]}` });
        return;
      }
      try {
        const inst = await launcher.open(home);
        await monitor.refresh(home.homeId);
        // 连接成功后立即索引一次（此时 runtime=running，liveStatus 实时通道可用），
        // 新会话/状态马上进入工作台，不用等下一个 60s tick。
        indexer.reindexNow(home.homeId);
        send(res, 200, inst);
      } catch (e) {
        send(res, 502, { error: e.message });
      }
      return;
    }

    const stopHome = pathname.match(/^\/api\/homes\/([0-9a-f]{16})\/stop$/);
    if (req.method === 'POST' && stopHome) {
      const home = store.getHome(stopHome[1]);
      if (!home) {
        send(res, 404, { error: `unknown homeId ${stopHome[1]}` });
        return;
      }
      const stopped = await launcher.stop(home);
      await monitor.refresh(home.homeId);
      send(res, 200, { ok: true, stopped });
      return;
    }

    const restartHome = pathname.match(/^\/api\/homes\/([0-9a-f]{16})\/restart$/);
    if (req.method === 'POST' && restartHome) {
      const home = store.getHome(restartHome[1]);
      if (!home) {
        send(res, 404, { error: `unknown homeId ${restartHome[1]}` });
        return;
      }
      try {
        const inst = await launcher.restart(home);
        await monitor.refresh(home.homeId);
        indexer.reindexNow(home.homeId); // 同 open：重启后立即索引，实时状态即刻入库
        send(res, 200, inst);
      } catch (e) {
        send(res, 502, { error: e.message });
      }
      return;
    }

    send(res, 404, { error: `not found: ${req.method} ${pathname}` });
  };
}
