import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { openTunnel } from './tunnel.js';
import { sshPathExists } from './prober.js';
import { fingerprint } from './guard.js';
import { InstanceRegistry } from './registry.js';
import { ensureRemoteToken, restartRemoteToken, stopRemote } from './remote.js';
import { createProxy } from './proxy.js';

// Launcher（§5）：本地 home 起 `dsh web`，远程 home 建 ssh -L 隧道。
// 进程句柄存 this.procs；控制状态（phase/url/port/pid）写入共享 registry，
// 由 Monitor 推进状态机。stop 前经 guard 指纹校验，防误杀。
export class Launcher {
  constructor({ registry = new InstanceRegistry() } = {}) {
    this.registry = registry;
    this.procs = new Map(); // homeId -> { pid, port, url, proc, deeplink, kind }
    process.on('exit', () => {
      for (const inst of this.procs.values()) inst.proc.kill();
    });
  }

  status(homeId) {
    const inst = this.procs.get(homeId);
    if (!inst || inst.proc.exitCode !== null) return null;
    return { url: inst.url, port: inst.port, pid: inst.pid, deeplink: inst.deeplink, kind: inst.kind };
  }

  async stop(home) {
    const inst = this.procs.get(home.homeId);
    // 远程:同时把远端 dsh web 停掉,而不是只拆隧道。
    if (home.hostType === 'remote') {
      try {
        await stopRemote(home);
      } catch (e) {
        console.warn(`[remote] 停止远端 dsh web 失败: ${e.message}`);
      }
    }
    if (!inst) {
      this.registry.set(home.homeId, { phase: 'stopped' });
      return false;
    }
    // guard：仅当这是我们持有且仍存活的子进程（pid 未被复用）才 kill，避免误杀。
    if (fingerprint(inst.proc)) {
      inst.proc.kill();
    } else {
      console.warn(`[guard] 拒绝 kill homeId=${home.homeId} pid=${inst.pid}（子进程已退出，pid 可能被复用）`);
    }
    // 拆掉反代（若已建），再更新状态。
    if (inst.proxy) await inst.proxy.close().catch(() => {});
    this.procs.delete(home.homeId);
    this.registry.set(home.homeId, { phase: 'stopped' });
    return fingerprint(inst.proc);
  }

  async open(home) {
    const running = this.status(home.homeId);
    if (running) return running;
    this.registry.set(home.homeId, { phase: 'probing' });
    if (home.hostType === 'remote') return this.#openRemote(home);
    return this.#openLocal(home);
  }

  // 重启：先撤当前实例（远程=停远端 dsh + 拆隧道；本地=杀进程），再拉起。
  async restart(home) {
    const running = this.status(home.homeId);
    if (running) await this.stop(home);
    this.registry.set(home.homeId, { phase: 'probing' });
    if (home.hostType !== 'remote') return this.#openLocal(home); // 本地重启 = 停 + 重开
    const token = await restartRemoteToken(home);
    return this.#connectRemote(home, token);
  }

  async #openLocal(home) {
    const port = await freePort();
    // 新版 dsh 要求显式 `--profile web`(裸 `dsh web` 会报 `--profile <name> is required`);
    // 旧版也兼容该写法。
    const proc = spawn('dsh', ['--profile', 'web', '--port', String(port), '--no-open'], {
      env: { ...process.env, DSH_HOME: home.homePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 8192) stderr = stderr.slice(-4096);
    });
    // 持续消费 stdout,避免 dsh 后续输出积压到管道缓冲、反压阻塞进程。
    proc.stdout.on('data', () => {});
    const baseUrl = `http://127.0.0.1:${port}`;
    const inst = { pid: proc.pid, port, url: baseUrl, proc, deeplink: false, kind: 'dsh-web' };
    this.procs.set(home.homeId, inst);
    proc.on('exit', () => this.procs.delete(home.homeId));

    // 新版 dsh(≥0.1.2-rc.1)启动时会往 stdout 打印鉴权 URL:
    //   `dsh web: http://127.0.0.1:<port>/?token=<launchToken>`
    // 裸 URL 会被 401 拒绝,必须带上 `?token=`(一次性换发签名 cookie 后跳转干净的 `/`)。
    // 旧版 dsh 不打印 token,则退回裸 URL 兼容。token 抓取与 HTTP 就绪并行,互不阻塞。
    try {
      const [tokenFragment] = await Promise.all([
        captureDshToken(proc, 20_000),
        waitForHttp(baseUrl, 20_000, () => proc.exitCode !== null),
      ]);
      // 反代入口: 浏览器只与 hwb 的代理端口通信(根路径 1:1 转发到上面的 dsh web,
      // 以绕开其根绝对 /plugins、/assets 路径对子路径代理不兼容的问题); token 拼在代理 URL 上完成首次握手。
      const proxy = await createProxy({ target: baseUrl });
      inst.proxy = proxy;
      const url = tokenFragment ? `${proxy.url}/${tokenFragment}` : proxy.url;
      inst.url = url;
      inst.deeplink = await probeDeeplink(url);
      this.registry.set(home.homeId, { phase: 'running', url, port: proxy.port, pid: inst.pid, deeplink: inst.deeplink });
      return { url, port: proxy.port, pid: inst.pid, deeplink: inst.deeplink };
    } catch (e) {
      if (inst.proxy) await inst.proxy.close().catch(() => {});
      this.procs.delete(home.homeId);
      proc.kill();
      this.registry.set(home.homeId, { phase: 'stopped', lastError: e.message });
      throw new Error(`dsh web did not come up: ${e.message}${stderr ? ` — ${stderr.trim().split('\n').pop()}` : ''}`);
    }
  }

  // 远程实例（§5.3 按需隧道）：确保远端 dsh web 在跑（起不来就拉起），抓回 token，
  // 再 ssh -L 隧道到远端端口，拼 token URL 供 iframe 访问（旧版无 token 则用普通 URL 兜底）。
  async #openRemote(home) {
    const token = await ensureRemoteToken(home);
    return this.#connectRemote(home, token);
  }

  async #connectRemote(home, tokenFragment) {
    const tunnel = await openTunnel({ host: home.host, remotePort: home.remotePort });
    const base = tunnel.url; // http://127.0.0.1:<local>
    // 新版 dsh web 需要 `?token=` 鉴权；旧版（无 token）回退到普通 URL。
    const hasToken = typeof tokenFragment === 'string' && tokenFragment.includes('token=') && tokenFragment !== '__NO_TOKEN__';
    const url = hasToken ? `${base}/${tokenFragment}` : base;
    const inst = { pid: tunnel.proc.pid, port: tunnel.localPort, url, proc: tunnel.proc, deeplink: false, kind: 'ssh' };
    this.procs.set(home.homeId, inst);
    tunnel.proc.on('exit', () => this.procs.delete(home.homeId));

    // 给 ssh 一点时间建立连接；若立即退出（host 不可达/认证失败）则报错。
    await new Promise((r) => setTimeout(r, 800));
    if (tunnel.proc.exitCode !== null) {
      this.procs.delete(home.homeId);
      const msg = tunnel.stderr().trim().split('\n').pop() || 'ssh exited early';
      this.registry.set(home.homeId, { phase: 'stopped', lastError: msg });
      throw new Error(`ssh 隧道建立失败: ${msg}（检查 ssh 别名/key 与远端可达性）`);
    }
    // 等远端 dsh web 可响应。
    try {
      await waitForHttp(url, 10_000, () => tunnel.proc.exitCode !== null);
    } catch (e) {
      this.procs.delete(home.homeId);
      tunnel.proc.kill();
      this.registry.set(home.homeId, { phase: 'stopped', lastError: e.message });
      throw new Error(`远程 dsh web 不可达: ${home.host}:${home.remotePort} — 请检查远端是否已装 dsh、端口是否正确、实例配置里的 remoteCmd/remoteLog 是否匹配`);
    }
    // 隧道连通后，核验远端上的 dsh home 目录可访问（homePath 的真实性检查，不能省略）。
    const remoteHome = home.remoteHome || '~/.dsh';
    if (!(await sshPathExists(home.host, remoteHome))) {
      this.procs.delete(home.homeId);
      tunnel.proc.kill();
      this.registry.set(home.homeId, { phase: 'stopped', lastError: 'remote home missing' });
      throw new Error(`远端 dsh home 不可访问: ${home.host}:${remoteHome} — 请检查该路径是否存在于远端（或在实例配置里指定 remoteHome）`);
    }
    // 反代入口: 浏览器只与 hwb 的代理端口通信; 代理根路径 1:1 转发到隧道(ssh -L)端口。
    const proxy = await createProxy({ target: base });
    inst.proxy = proxy;
    const proxyUrl = hasToken ? `${proxy.url}/${tokenFragment}` : proxy.url;
    inst.url = proxyUrl;
    inst.deeplink = await probeDeeplink(proxyUrl);
    this.registry.set(home.homeId, { phase: 'running', url: proxyUrl, port: proxy.port, pid: inst.pid, deeplink: inst.deeplink });
    return { url: proxyUrl, port: proxy.port, pid: inst.pid, deeplink: inst.deeplink };
  }
}

// 从 dsh web 的 stdout 抓取新版启动时打印的鉴权 token 片段(如 `?token=xyz`)。
// 新版 dsh(≥0.1.2-rc.1)会打印 `dsh web: http://127.0.0.1:<port>/?token=<launchToken>`,
// 裸 URL 会被 401 拒绝;旧版不打印 token,此时返回 null 以便用裸 URL 兜底。
// 只解析「完整行」,避免把半截 token(如 `?to`)误判成旧版无 token。进程退出或超时返回 null。
export function captureDshToken(proc, timeoutMs) {
  return new Promise((resolve) => {
    let buf = '';
    const settle = (fragment) => {
      clearTimeout(timer);
      proc.stdout.off('data', onData);
      proc.off('exit', onExit);
      resolve(fragment);
    };
    const onExit = () => settle(null);
    const onData = (d) => {
      buf += d;
      if (buf.length > 64 * 1024) buf = buf.slice(-64 * 1024);
      const lines = buf.split('\n');
      // 末尾若无换行,最后一段是未完成的半行,不解析(避免误判)。
      if (!buf.endsWith('\n')) lines.pop();
      for (const line of lines) {
        if (!line.includes('dsh web:')) continue;
        const tok = line.match(/\?token=[A-Za-z0-9_-]+/);
        if (tok) { settle(tok[0]); return; }        // 新版: 该行带 token
        if (line.includes('http')) { settle(null); return; } // 旧版: 裸 URL 无 token
        // 否则(如 "opening the default browser" 提示)仍在等真正的 URL 行,继续。
      }
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    proc.stdout.on('data', onData);
    proc.on('exit', onExit);
  });
}

// 完成 dsh web 的 token→cookie 交接后取回真正的页面正文。
// 新版 dsh 的 `/?token=...` 会 303 到 `/` 并 Set-Cookie;Node 的 fetch(undici)默认不
// 跨重定向携带 cookie,所以需手动把 `set-cookie` 带回再请求指向的 `/`,否则读到的是
// 401 提示文本而不是 index.html。旧版 dsh 无 token 栅栏(直接 200/其他),原样返回。
export async function authFetch(url, timeoutMs = 4000) {
  const first = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  if (first.status !== 303) return first;
  const cookie = first.headers.get('set-cookie') || '';
  const target = new URL(first.headers.get('location') || '/', url);
  const second = await fetch(target, {
    redirect: 'manual',
    headers: cookie ? { cookie: cookie.split(';')[0] } : {}, // 只带 `name=value`,去掉 Path/HttpOnly 等
    signal: AbortSignal.timeout(timeoutMs),
  });
  // 个别配置二次仍 303(可能再换 cookie),再带 cookie 追一次。
  if (second.status === 303) {
    const c2 = second.headers.get('set-cookie') || cookie;
    const t2 = new URL(second.headers.get('location') || '/', url);
    return fetch(t2, {
      redirect: 'manual',
      headers: { cookie: (c2 || '').split(';')[0] },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
  return second;
}

// 检测目标 dsh web 是否具备会话深链（boot 携带 @deepseek-ai/dsh-session-deeplink 客户端插件）。
// 先完成 token→cookie 交接再读正文——否则会被 401 栅栏挡住,永远看不到真正的 index.html;
// 插件存在时其标记会出现在服务端 HTML 里,不存在(如 v0.1.2-rc.1 原厂)则返回 false。
export async function probeDeeplink(url) {
  try {
    const res = await authFetch(url);
    const html = await res.text().catch(() => '');
    return html.includes('session-deeplink');
  } catch {
    return false;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, timeoutMs, isDead) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isDead()) throw new Error('process exited early');
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.status < 500) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 300));
  }
}
