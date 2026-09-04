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

export function createRouter({ store, indexer, hub, launcher, monitor, quota }) {
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
        const homePath = `ssh://${host}:${remotePort}`;
        const homeId = store.registerHome({ homePath, alias, hostType: 'remote', host, remotePort, remoteHome, remoteCmd, remoteLog });
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
      const homeId = store.registerHome({ homePath, alias, hostType: 'local' });
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
        },
      });
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
        send(res, 200, inst);
      } catch (e) {
        send(res, 502, { error: e.message });
      }
      return;
    }

    send(res, 404, { error: `not found: ${req.method} ${pathname}` });
  };
}
