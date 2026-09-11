import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { openTunnel } from './tunnel.js';
import { httpProbe, sshPathExists } from './prober.js';
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
  constructor({ registry = new InstanceRegistry(), tunnelFactory = openTunnel, remotePathExists = sshPathExists, waitHttp = waitForHttp, tunnelReadyDelayMs = 800, recoveryDelaysMs = [1000, 2000, 4000, 8000, 16_000], stopRemoteFn = stopRemote, rememberAccessPort = () => {} } = {}) {
    this.registry = registry;
    this.tunnelFactory = tunnelFactory;
    this.remotePathExists = remotePathExists;
    this.waitHttp = waitHttp;
    this.tunnelReadyDelayMs = tunnelReadyDelayMs;
    this.recoveryDelaysMs = recoveryDelaysMs;
    this.stopRemoteFn = stopRemoteFn;
    this.rememberAccessPort = rememberAccessPort;
    this.procs = new Map(); // homeId -> { pid, port, url, proc, deeplink, kind }
    process.on('exit', () => {
      for (const inst of this.procs.values()) {
        this.#cancelRecovery(inst);
        if (inst.proc) inst.proc.kill();
      }
    });
  }

  status(homeId) {
    const inst = this.procs.get(homeId);
    // 直连已有实例（adopted-local）无子进程：只判「是否处于运行态」，不能靠 exitCode。
    if (!inst || inst.detached || inst.cancelled || (!inst.recovering && inst.proc && (inst.proc.exitCode !== null || inst.proc.signalCode != null))) return null;
    return { url: inst.url, iframeUrl: inst.iframeUrl, port: inst.port, pid: inst.pid, deeplink: inst.deeplink, kind: inst.kind, recovering: !!inst.recovering };
  }

  // 仅撤销 hwb 接入；不停止远端 dsh web。
  async disconnect(home) {
    const inst = this.procs.get(home.homeId);
    this.#cancelRecovery(inst);
    // 本机受管进程保留所有权，断开只撤销 hwb 接入，之后可以重新连接。
    if (inst?.previewProxy) await inst.previewProxy.close();
    if (inst?.proxy) await inst.proxy.close();
    if (inst?.kind === 'ssh' && fingerprint(inst.proc)) inst.proc.kill();
    if (inst?.kind === 'dsh-web') {
      inst.detached = true;
      delete inst.previewProxy;
      delete inst.previewPending;
      delete inst.iframeUrl;
    } else this.procs.delete(home.homeId);
    this.registry.set(home.homeId, { phase: 'stopped', url: null, iframeUrl: null, port: null, pid: null });
  }

  async stop(home) {
    const inst = this.procs.get(home.homeId);
    this.#cancelRecovery(inst);
    // 远程:同时把远端 dsh web 停掉,而不是只拆隧道。
    if (home.hostType === 'remote') {
      try {
        await this.stopRemoteFn(home);
      } catch (e) {
        log.warn('停止远端 dsh web 失败', { homeId: home.homeId, host: home.host, remotePort: home.remotePort, err: e });
      }
    }
    if (!inst) {
      this.registry.set(home.homeId, { phase: 'stopped', url: null, iframeUrl: null, port: null, pid: null });
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
    if (inst.previewProxy) await inst.previewProxy.close().catch(() => {});
    if (inst.proxy) await inst.proxy.close().catch(() => {});
    this.procs.delete(home.homeId);
    this.registry.set(home.homeId, { phase: 'stopped', url: null, iframeUrl: null, port: null, pid: null });
    return inst.proc ? fingerprint(inst.proc) : false;
  }

  // 「连接」语义（默认）：连接到已有的 dsh 实例，而不是习惯性启动一个新的。
  //   · 已连接且隧道存活 → 直接复用现有连接；
  //   · 远程：连接落在「重建 ssh 转发」接入已有的远端 dsh web（见 #openRemote），
  //     仅当远端确实没有实例在跑时才把它拉起；
  //   · 本地：连接即「确保本地 dsh web 在跑并连入」（hwb 需持有子进程以抓 token）。
  async open(home) {
    const previous = this.procs.get(home.homeId);
    if (previous?.recovering && !previous.cancelled) {
      if (!previous.recoveryPromise) previous.recoveryAttempts = 0;
      return this.#recoverRemote(home, previous);
    }
    if (previous?.detached) {
      if (home.localPort && Number(home.localPort) !== previous.port) throw new Error('请先在设置中停止原本机进程，再连接其他端口');
      previous.detached = false;
      previous.cancelled = false;
    }
    const running = this.status(home.homeId);
    if (running) {
      try { return await this.#withPreview(home, running); }
      catch (error) { await this.disconnect(home); throw error; }
    }
    this.registry.set(home.homeId, { phase: 'probing' });
    const result = home.hostType === 'remote' ? await this.#openRemote(home) : await this.#openLocal(home);
    try { return await this.#withPreview(home, result); }
    catch (error) { await this.disconnect(home); throw error; }
  }

  // 先验证新端点，再释放旧连接；失败时当前连接和实例身份不变。
  async switchEndpoint(home, target) {
    if (this.procs.get(home.homeId)?.kind === 'dsh-web') throw new Error('请先停止 hwb 启动的本机进程，再切换直连端点');
    const stagingId = `${home.homeId}:switch`;
    const staged = { ...target, homeId: stagingId, connectOnly: true, accessPort: null, transient: true };
    try {
      let result = await this.open(staged);
      const response = await authFetch(result.url);
      await response.body?.cancel();
      if (!response.ok) throw new Error(`新端点鉴权或响应失败（HTTP ${response.status}）`);
      const next = this.procs.get(stagingId);
      if (!next || !this.status(stagingId)) throw new Error('新端点连接已失效');
      const previous = this.procs.get(home.homeId);
      if (home.hostType === 'remote' && previous?.previewProxy) {
        const temporary = next.previewProxy;
        this.#transferPreview(next, previous);
        await temporary.close();
      } else if (home.hostType === 'remote') {
        await next.previewProxy.close();
        delete next.previewProxy;
        await this.#withPreview(home, result, next);
      }
      result = { ...result, iframeUrl: next.iframeUrl };
      await this.disconnect(home);
      this.procs.delete(stagingId);
      staged.homeId = home.homeId; // SSH exit 回调随连接归入稳定的实例 ID。
      staged.transient = false;
      staged.accessPort = next.previewProxy?.port ?? null;
      this.procs.set(home.homeId, next);
      this.registry.set(home.homeId, { ...result, homeId: home.homeId, phase: 'running', lastError: null, attempts: 0 });
      return result;
    } catch (error) {
      await this.disconnect({ homeId: stagingId }).catch(() => {});
      throw error;
    } finally { this.registry.delete(stagingId); }
  }

  async #withPreview(home, result, inst = this.procs.get(home.homeId)) {
    if (!inst) return result;
    const remote = home.hostType === 'remote';
    if (!inst.previewProxy) {
      // Separate iframe entry preserves the original external dsh URL.
      inst.previewPending ||= createProxy({ target: new URL(inst.url).origin, preview: true, port: remote ? home.accessPort || 0 : 0 });
      try { inst.previewProxy = await inst.previewPending; }
      catch (error) {
        if (error.code === 'EADDRINUSE') throw new Error(`本地端口 ${home.accessPort} 已被占用，请释放该端口或在实例设置中更换`);
        throw error;
      }
      finally { inst.previewPending = null; }
      if (remote && !home.transient) {
        try {
          this.rememberAccessPort(home.homeId, inst.previewProxy.port);
          home.accessPort = inst.previewProxy.port;
        } catch (error) {
          await inst.previewProxy.close();
          delete inst.previewProxy;
          throw error;
        }
      }
      inst.iframeUrl = inst.previewProxy.url + '/' + new URL(inst.url).search;
      if (this.procs.get(home.homeId) === inst) this.registry.set(home.homeId, { iframeUrl: inst.iframeUrl });
    }
    return { ...result, iframeUrl: inst.iframeUrl };
  }

  #transferPreview(inst, previous) {
    inst.previewProxy = previous.previewProxy;
    delete previous.previewProxy;
    inst.previewProxy.retarget(new URL(inst.url).origin);
    inst.iframeUrl = inst.previewProxy.url + '/' + new URL(inst.url).search;
  }

  // 重启：先撤当前实例（远程=停远端 dsh + 拆隧道；本地=杀进程），再拉起。
  async restart(home) {
    const running = this.status(home.homeId);
    if (running) await this.stop(home);
    this.registry.set(home.homeId, { phase: 'probing' });
    if (home.hostType !== 'remote') return this.#withPreview(home, await this.#openLocal(home)); // 本地重启 = 停 + 重开
    const token = await restartRemoteToken(home);
    return this.#withPreview(home, await this.#connectRemote(home, token));
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
      inst.previewProxy?.close().catch(() => {});
      if (this.procs.get(home.homeId) === inst) this.procs.delete(home.homeId);
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

  #cancelRecovery(inst) {
    if (!inst) return;
    inst.cancelled = true;
    inst.recovering = false;
    if (inst.recoveryTimer) clearTimeout(inst.recoveryTimer);
    inst.recoveryTimer = null;
    const pending = inst.recoveryPending;
    if (pending) {
      pending.cancelled = true;
      if (fingerprint(pending.proc)) pending.proc.kill();
      pending.previewProxy?.close().catch(() => {});
      pending.proxy?.close().catch(() => {});
    }
  }

  async #releaseRemote(inst) {
    this.#cancelRecovery(inst);
    if (fingerprint(inst.proc)) inst.proc.kill();
    await Promise.allSettled([inst.previewProxy?.close(), inst.proxy?.close()]);
  }

  #scheduleRecovery(home, inst) {
    if (this.procs.get(home.homeId) !== inst || inst.cancelled || !inst.recovering || inst.recoveryTimer) return;
    const delayMs = this.recoveryDelaysMs[inst.recoveryAttempts ?? 0];
    if (delayMs === undefined) return; // 有界重试；用户仍可点击连接重新尝试。
    inst.recoveryTimer = setTimeout(() => {
      inst.recoveryTimer = null;
      this.#recoverRemote(home, inst).catch(() => {});
    }, delayMs);
    inst.recoveryTimer.unref?.();
  }

  #recoverRemote(home, previous) {
    if (previous.recoveryPromise) return previous.recoveryPromise;
    if (this.procs.get(home.homeId) !== previous || previous.cancelled) return Promise.reject(new Error('连接已取消'));
    if (previous.recoveryTimer) clearTimeout(previous.recoveryTimer);
    previous.recoveryTimer = null;
    previous.recoveryAttempts = (previous.recoveryAttempts ?? 0) + 1;
    // 只沿用已连接实例的 token 重建隧道，绝不走 ensureRemoteToken 的启动路径。
    previous.recoveryPromise = this.#connectRemote(home, previous.tokenFragment, previous).catch((error) => {
      if (this.procs.get(home.homeId) === previous && !previous.cancelled) {
        this.registry.set(home.homeId, { phase: 'degraded', lastError: error.message });
        this.#scheduleRecovery(home, previous);
      }
      throw error;
    }).finally(() => { previous.recoveryPromise = null; });
    return previous.recoveryPromise;
  }

  async #connectRemote(home, tokenFragment, replacing = null) {
    const tunnel = await this.tunnelFactory({ host: home.host, remotePort: home.remotePort });
    const base = tunnel.url;
    const hasToken = isTokenFragment(tokenFragment);
    const url = hasToken ? `${base}/${tokenFragment}` : base;
    const inst = { pid: tunnel.proc.pid, port: tunnel.localPort, url, proc: tunnel.proc, deeplink: false, kind: 'ssh', tokenFragment };
    // 新隧道在完全就绪前不替换旧实例。断开/端点切换可取消正在准备的候选连接。
    if (replacing) {
      if (this.procs.get(home.homeId) !== replacing || replacing.cancelled) {
        await this.#releaseRemote(inst);
        throw new Error('连接已取消');
      }
      replacing.recoveryPending = inst;
    } else this.procs.set(home.homeId, inst);
    const isCurrent = () => !inst.cancelled && (replacing
      ? this.procs.get(home.homeId) === replacing && !replacing.cancelled && replacing.recoveryPending === inst
      : this.procs.get(home.homeId) === inst);
    const assertCurrent = () => {
      if (!isCurrent()) throw new Error('连接已取消');
      if (tunnel.proc.exitCode !== null || tunnel.proc.signalCode != null) throw new Error(tunnel.stderr().trim().split('\n').pop() || 'ssh exited early');
    };
    tunnel.proc.on('exit', (code, signal) => {
      if (signal !== null) log.debug('ssh 隧道子进程退出（被信号终止）', { homeId: home.homeId, signal });
      else if (code === 0) log.info('ssh 隧道子进程退出', { homeId: home.homeId });
      else log.warn('ssh 隧道子进程异常退出', { homeId: home.homeId, exitCode: code, stderr: tunnel.stderr().trim().split('\n').slice(-12).join('\n') });
      if (this.procs.get(home.homeId) !== inst || inst.cancelled || !inst.connected) return;
      inst.recovering = true;
      inst.recoveryAttempts = 0;
      this.registry.set(home.homeId, { phase: 'degraded', lastError: 'SSH 连接已断开，正在重新连接' });
      this.#scheduleRecovery(home, inst);
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, this.tunnelReadyDelayMs));
      assertCurrent();
      await this.waitHttp(url, 30_000, () => !isCurrent() || tunnel.proc.exitCode !== null || tunnel.proc.signalCode != null);
      assertCurrent();
      const remoteHome = home.remoteHome || '~/.dsh';
      if (!(await this.remotePathExists(home.host, remoteHome))) throw new Error(`远端 dsh home 不可访问: ${home.host}:${remoteHome}${selfServiceHint(home)}`);
      assertCurrent();
      inst.proxy = await createProxy({ target: base });
      assertCurrent();
      inst.url = hasToken ? `${inst.proxy.url}/${tokenFragment}` : inst.proxy.url;
      inst.port = inst.proxy.port;
      inst.deeplink = await probeDeeplink(inst.url);
      assertCurrent();
      let result = { url: inst.url, port: inst.port, pid: inst.pid, deeplink: inst.deeplink };
      if (replacing) {
        if (!replacing.previewProxy) result = await this.#withPreview(home, result, inst);
        assertCurrent();
        if (replacing.previewProxy) {
          this.#transferPreview(inst, replacing);
          result = { ...result, iframeUrl: inst.iframeUrl };
        }
        replacing.recoveryPending = null;
        this.procs.set(home.homeId, inst);
      }
      inst.connected = true;
      this.registry.set(home.homeId, { ...result, phase: 'running', lastError: null, attempts: 0 });
      if (replacing) await this.#releaseRemote(replacing);
      log.info(replacing ? '远程 SSH 连接已恢复' : '远程 dsh web 已接入', { homeId: home.homeId, host: home.host, remotePort: home.remotePort, port: inst.port, hasToken });
      return result;
    } catch (error) {
      await this.#releaseRemote(inst);
      if (replacing?.recoveryPending === inst) replacing.recoveryPending = null;
      if (!replacing && this.procs.get(home.homeId) === inst) {
        this.procs.delete(home.homeId);
        this.registry.set(home.homeId, { phase: 'stopped', url: null, iframeUrl: null, port: null, pid: null, lastError: error.message });
      }
      throw error;
    }
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
    // A remote response can exceed one second while bundles share the tunnel.
    // Probe headers only, without following the token redirect or retaining a body.
    const remaining = Math.max(1, deadline - Date.now());
    if (await httpProbe(url, Math.min(5000, remaining))) return;
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 300));
  }
}
