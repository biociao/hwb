import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { openTunnel } from './tunnel.js';
import { sshPathExists } from './prober.js';
import { fingerprint } from './guard.js';
import { InstanceRegistry } from './registry.js';
import { ensureRemoteToken, restartRemoteToken, stopRemote, normalizeWebToken, selfServiceHint } from './remote.js';
import { createProxy } from './proxy.js';
import { logger } from '../lib/logger.js';

const log = logger('launcher');

// Launcher（§5）：本地 home 起 `dsh web`，远程 home 建 ssh -L 隧道。
// 进程句柄存 this.procs；控制状态（phase/url/port/pid）写入共享 registry，
// 由 Monitor 推进状态机。stop 前经 guard 指纹校验，防误杀。
export class Launcher {
  constructor({ registry = new InstanceRegistry() } = {}) {
    this.registry = registry;
    this.procs = new Map(); // homeId -> { pid, port, url, proc, deeplink, kind }
    process.on('exit', () => {
      for (const inst of this.procs.values()) {
        if (inst.proc) inst.proc.kill();
      }
    });
  }

  status(homeId) {
    const inst = this.procs.get(homeId);
    // 直连已有实例（adopted-local）无子进程：只判「是否处于运行态」，不能靠 exitCode。
    if (!inst || (inst.proc && inst.proc.exitCode !== null)) return null;
    return { url: inst.url, port: inst.port, pid: inst.pid, deeplink: inst.deeplink, kind: inst.kind };
  }

  async stop(home) {
    const inst = this.procs.get(home.homeId);
    // 远程:同时把远端 dsh web 停掉,而不是只拆隧道。
    if (home.hostType === 'remote') {
      try {
        await stopRemote(home);
      } catch (e) {
        log.warn('停止远端 dsh web 失败', { homeId: home.homeId, host: home.host, remotePort: home.remotePort, err: e });
      }
    }
    if (!inst) {
      this.registry.set(home.homeId, { phase: 'stopped' });
      log.info('stop: 实例未在运行', { homeId: home.homeId });
      return false;
    }
    if (inst.proc) {
      // guard：仅当这是我们持有且仍存活的子进程（pid 未被复用）才 kill，避免误杀。
      if (fingerprint(inst.proc)) {
        log.info('stop: kill 子进程', { homeId: home.homeId, pid: inst.pid, signal: 'SIGTERM' });
        inst.proc.kill();
      } else {
        log.warn('guard 拒绝 kill（子进程已退出，pid 可能被复用）', { homeId: home.homeId, pid: inst.pid });
      }
    } else {
      // 直连已有实例（adopted-local）：不归 hwb 管、无子进程可 kill，只拆除。
      log.debug('stop: 直连实例无子进程，跳过 kill', { homeId: home.homeId, kind: inst.kind });
    }
    // 拆掉反代（若已建），再更新状态。
    if (inst.proxy) await inst.proxy.close().catch(() => {});
    this.procs.delete(home.homeId);
    this.registry.set(home.homeId, { phase: 'stopped' });
    return inst.proc ? fingerprint(inst.proc) : false;
  }

  // 「连接」语义（默认）：连接到已有的 dsh 实例，而不是习惯性启动一个新的。
  //   · 已连接且隧道存活 → 直接复用现有连接；
  //   · 远程：连接落在「重建 ssh 转发」接入已有的远端 dsh web（见 #openRemote），
  //     仅当远端确实没有实例在跑时才把它拉起；
  //   · 本地：连接即「确保本地 dsh web 在跑并连入」（hwb 需持有子进程以抓 token）。
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

  // 「连接」本地实例：hwb 需持有子进程才能从 stdout 抓 token，故“连接”即“确保本地 dsh web
  // 在跑并连入”（若 hwb 上次已拉起且进程仍在，open() 会直接复用，不重复起）。
  async #openLocal(home) {
    // 「连接已运行的本机 dsh web」：用户在实例配置里手填了本机端口（可选 token）时，直接接入
    // 这台已在跑的 dsh web——同机直连，不再新拉起、不建反代，也不打断已有实例（稳定第一）。
    if (home.localPort && Number.isInteger(Number(home.localPort)) && Number(home.localPort) > 0) {
      return this.#connectLocalExisting(home);
    }
    const port = await freePort();
    // 用裸 `dsh web` 别名启动（新版等价于 `--profile web`，旧版 v0.1.x 原生支持），显式 `--port`。
    // 本机保留 `--no-open`：本地 dsh 为主机自己装的（通常已升级到 ≥0.1.2-rc.1），
    // 且我们要避免 hwb 之外再弹一个浏览器标签。
    const proc = spawn('dsh', ['web', '--port', String(port), '--no-open'], {
      env: { ...process.env, DSH_HOME: home.homePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    const lastStderr = (n = 8) => stderr.trim().split('\n').slice(-n).join('\n');
    proc.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 32 * 1024) stderr = stderr.slice(-16 * 1024);
    });
    // 持续消费 stdout,避免 dsh 后续输出积压到管道缓冲、反压阻塞进程。
    proc.stdout.on('data', () => {});
    const baseUrl = `http://127.0.0.1:${port}`;
    const inst = { pid: proc.pid, port, url: baseUrl, proc, deeplink: false, kind: 'dsh-web' };
    this.procs.set(home.homeId, inst);
    // 子进程生命周期记录：非 0 退出视为崩溃，带上退出码与 stderr 尾部，便于排查。
    proc.on('exit', (code, signal) => {
      this.procs.delete(home.homeId);
      if (signal !== null) {
        log.debug('dsh web 子进程退出（被信号终止）', { homeId: home.homeId, pid: inst.pid, signal });
      } else if (code === 0) {
        log.info('dsh web 子进程正常退出', { homeId: home.homeId, pid: inst.pid });
      } else {
        log.warn('dsh web 子进程崩溃退出', { homeId: home.homeId, pid: inst.pid, exitCode: code, stderr: lastStderr(12) });
      }
    });

    // 新版 dsh(≥0.1.2-rc.1)启动时会往 stdout 打印鉴权 URL:
    //   `dsh web: http://127.0.0.1:<port>/?token=<launchToken>`
    // 裸 URL 会被 401 拒绝,必须带上 `?token=`(一次性换发签名 cookie 后跳转干净的 `/`)。
    // 旧版 dsh 不打印 token,则退回裸 URL 兼容。token 抓取与 HTTP 就绪并行,互不阻塞。
    try {
      const [tokenFragment] = await Promise.all([
        captureDshToken(proc, 20_000),
        waitForHttp(baseUrl, 20_000, () => proc.exitCode !== null),
      ]);
      // 本地 dsh web 与本机浏览器同机可达，无需 hwb 侧反代/端口转发：iframe 与「在外部浏览器打开」
      // 一律用原始服务连接 `http://127.0.0.1:<port>/?token=<x>`（旧版 dsh 不打印 token 则回退裸 URL）。
      // 这样 URL 才是真实的 dsh 端点——token 可见、不依赖 hwb 进程存活的反代入口（即使 hwb 退出，
      // 该 URL 也是真实地址而非转发门面）。远程实例仍需反代（ssh -L 隧道本身不可被浏览器直达），见 #connectRemote。
      const url = localWebUrl(baseUrl, tokenFragment);
      inst.url = url;
      inst.deeplink = await probeDeeplink(url);
      this.registry.set(home.homeId, { phase: 'running', url, port, pid: inst.pid, deeplink: inst.deeplink });
      log.info('本地 dsh web 已启动', { homeId: home.homeId, pid: inst.pid, port, deeplink: inst.deeplink });
      return { url, port, pid: inst.pid, deeplink: inst.deeplink };
    } catch (e) {
      if (inst.proxy) await inst.proxy.close().catch(() => {});
      this.procs.delete(home.homeId);
      proc.kill();
      this.registry.set(home.homeId, { phase: 'stopped', lastError: e.message });
      log.error('启动本地 dsh web 失败', e, { homeId: home.homeId, port, baseUrl, stderr: lastStderr(24) });
      throw new Error(`dsh web did not come up: ${e.message}${stderr ? ` — ${stderr.trim().split('\n').pop()}` : ''}`);
    }
  }

  // 「直连已运行的本机 dsh web」：当实例配置里手填了本机端口（localPort）时，接入这台已在跑的
  // dsh web，而不是另起一个新的。同机可达 → 一律用**原始服务连接**（localWebUrl，无反代），
  // token 来自配置（手填，normalizeWebToken），旧版无 token 则回退裸 URL。
  // hwb 只做「持有状态 + 探活」，不持有子进程（inst.proc=null），stop/exit 也不会去 kill 它。
  async #connectLocalExisting(home) {
    const port = Number(home.localPort);
    const tokenFragment = normalizeWebToken(home.token);
    const base = `http://127.0.0.1:${port}`;
    const url = localWebUrl(base, tokenFragment); // 直连服务地址，不经 hwb 反代/端口转发
    const inst = { pid: null, port, url, proc: null, deeplink: false, kind: 'adopted-local' };
    this.procs.set(home.homeId, inst);
    try {
      // 等该 dsh web 可响应。实例不归我们管（无子进程可探测退出），isDead 恒 false，靠 timeout 兜底。
      await waitForHttp(url, 10_000, () => false);
    } catch (e) {
      this.procs.delete(home.homeId);
      this.registry.set(home.homeId, { phase: 'stopped', lastError: e.message });
      log.error('直连本机 dsh web 不可达', e, { homeId: home.homeId, port, url });
      throw new Error(
        `本机 dsh web 不可达: http://127.0.0.1:${port} — 请确认该端口上的实例在跑`
        + (tokenFragment ? '' : '，并在实例配置里填 dsh web 鉴权 token（新版 dsh 需要）')
      );
    }
    inst.deeplink = await probeDeeplink(url);
    this.registry.set(home.homeId, { phase: 'running', url, port, pid: null, deeplink: inst.deeplink });
    log.info('已直连本机 dsh web（采用配置端口）', { homeId: home.homeId, port, deeplink: inst.deeplink });
    return { url, port, pid: null, deeplink: inst.deeplink };
  }

  // 「连接」已有远端实例（§5.3 按需隧道）：默认动作是【重建一条 ssh -L 转发】去接入
  // 已在运行的远端 dsh web，而不是在远端启动一个新的——`ensureRemoteToken` 的 ensure 模式
  // 在端口已监听时直接复用（日志有 token）或返回 `__NO_TOKEN__`（旧版兜底），不做 kill/restart；
  // 仅当远端确实没在监听时才把它拉起（“连接”一个不存在的事物没有意义）。
  //
  // 稳定第一（hwb 连接原则）：若用户在实例配置里【手填了 token】（远端 dsh 已自行更新），
  // 则用该 token 直接连接，完全不在远端启动/重启/杀进程——把「打断实例」的代价降到零。
  async #openRemote(home) {
    const handToken = normalizeWebToken(home.token);
    if (handToken) {
      log.info('使用实例配置中手填的 token 连接（重建隧道，不启动/重启远端 dsh web）', {
        homeId: home.homeId, host: home.host, remotePort: home.remotePort,
      });
      return this.#connectRemote(home, handToken);
    }
    const token = await ensureRemoteToken(home);
    return this.#connectRemote(home, token);
  }

  async #connectRemote(home, tokenFragment) {
    const tunnel = await openTunnel({ host: home.host, remotePort: home.remotePort });
    const base = tunnel.url; // http://127.0.0.1:<local>
    // 新版 dsh web 需要 `?token=` 鉴权；旧版（无 token）回退到普通 URL。
    const hasToken = isTokenFragment(tokenFragment);
    const url = hasToken ? `${base}/${tokenFragment}` : base;
    const inst = { pid: tunnel.proc.pid, port: tunnel.localPort, url, proc: tunnel.proc, deeplink: false, kind: 'ssh' };
    this.procs.set(home.homeId, inst);
    tunnel.proc.on('exit', (code, signal) => {
      this.procs.delete(home.homeId);
      if (signal !== null) log.debug('ssh 隧道子进程退出（被信号终止）', { homeId: home.homeId, signal });
      else if (code === 0) log.info('ssh 隧道子进程退出', { homeId: home.homeId });
      else log.warn('ssh 隧道子进程异常退出', { homeId: home.homeId, exitCode: code, stderr: tunnel.stderr().trim().split('\n').slice(-12).join('\n') });
    });

    // 给 ssh 一点时间建立连接；若立即退出（host 不可达/认证失败）则报错。
    await new Promise((r) => setTimeout(r, 800));
    if (tunnel.proc.exitCode !== null) {
      const msg = tunnel.stderr().trim().split('\n').pop() || 'ssh exited early';
      this.procs.delete(home.homeId);
      this.registry.set(home.homeId, { phase: 'stopped', lastError: msg });
      log.error('ssh 隧道建立失败', { homeId: home.homeId, host: home.host, remotePort: home.remotePort, stderr: tunnel.stderr().trim() });
      throw new Error(`ssh 隧道建立失败: ${msg}（检查 ssh 别名/key 与远端可达性）`);
    }
    // 等远端 dsh web 可响应。
    try {
      await waitForHttp(url, 10_000, () => tunnel.proc.exitCode !== null);
    } catch (e) {
      this.procs.delete(home.homeId);
      tunnel.proc.kill();
      this.registry.set(home.homeId, { phase: 'stopped', lastError: e.message });
      // 把 SSH 隧道 stderr 一并带进上下文，便于区分「隧道没建通」vs「远端 web 没起来」。
      const tunnelErr = tunnel.stderr().trim();
      log.error('远程 dsh web 不可达', e, {
        homeId: home.homeId, host: home.host, remotePort: home.remotePort, url,
        remoteCmd: home.remoteCmd, remoteLog: home.remoteLog,
        tunnelStderr: tunnelErr ? tunnelErr.split('\n').slice(-6).join('\n') : undefined,
      });
      throw new Error(`远程 dsh web 不可达: ${home.host}:${home.remotePort} — 请检查远端是否已装 dsh、端口是否正确、实例配置里的 remoteCmd/remoteLog 是否匹配${tunnelErr ? `（ssh: ${tunnelErr.split('\n').pop()}）` : ''}${selfServiceHint(home)}`);
    }
    // 隧道连通后，核验远端上的 dsh home 目录可访问（homePath 的真实性检查，不能省略）。
    const remoteHome = home.remoteHome || '~/.dsh';
    if (!(await sshPathExists(home.host, remoteHome))) {
      this.procs.delete(home.homeId);
      tunnel.proc.kill();
      this.registry.set(home.homeId, { phase: 'stopped', lastError: 'remote home missing' });
      log.error('远端 dsh home 不可访问', { homeId: home.homeId, host: home.host, remoteHome });
      throw new Error(`远端 dsh home 不可访问: ${home.host}:${remoteHome} — 请检查该路径是否存在于远端（或在实例配置里指定 remoteHome）${selfServiceHint(home)}`);
    }
    // 反代入口: 浏览器只与 hwb 的代理端口通信; 代理根路径 1:1 转发到隧道(ssh -L)端口。
    const proxy = await createProxy({ target: base });
    inst.proxy = proxy;
    const proxyUrl = hasToken ? `${proxy.url}/${tokenFragment}` : proxy.url;
    inst.url = proxyUrl;
    inst.deeplink = await probeDeeplink(proxyUrl);
    this.registry.set(home.homeId, { phase: 'running', url: proxyUrl, port: proxy.port, pid: inst.pid, deeplink: inst.deeplink });
    log.info('远程 dsh web 已接入', { homeId: home.homeId, host: home.host, remotePort: home.remotePort, port: proxy.port, hasToken });
    return { url: proxyUrl, port: proxy.port, pid: inst.pid, deeplink: inst.deeplink };
  }
}

// 判定远端 token 片段是否为「真 token」（决定拼 `?token=` 还是回退裸 URL）。
// 向下兼容：旧版 dsh（不生成 token）会返回哨兵 `__NO_TOKEN__`（或本地 capture 返回 null），
// 此时 MUST 用裸 URL 连接，而不是把它误当成 token。
export function isTokenFragment(tf) {
  return typeof tf === 'string' && tf !== '__NO_TOKEN__' && tf.includes('token=');
}

// 本地 dsh web 的**原始服务连接** URL（不经 hwb 反代）：= 本机直连地址 base + token 片段。
// 新版带 `?token=`（token 可见、可跨 hwb 生命周期复用），旧版无 token 则回退裸 URL。
export function localWebUrl(base, tokenFragment) {
  return isTokenFragment(tokenFragment) ? `${base}/${tokenFragment}` : base;
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
