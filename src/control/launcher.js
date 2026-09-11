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

// 停止子进程的两段等待：先 SIGTERM 等 3s，再 SIGKILL 等 2s。
// 3s 的依据是 dsh web 自己的收尾（关监听、flush 日志）实测在 1s 内；给到 3s 是为了容忍磁盘慢的机器，
// 同时不让「停止」按钮在进程已死的情况下多等。SIGKILL 之后再等 2s 是为了拿到 exit 事件
// （kill 只是投递信号，不保证立刻回收）。
const STOP_TERM_MS = 3000;
const STOP_KILL_MS = 2000;

// Launcher（§5）：本地 home 起 `dsh web`，远程 home 建 ssh -L 隧道。
// 进程句柄存 this.procs；控制状态（phase/url/port/pid）写入共享 registry，
// 由 Monitor 推进状态机。stop 前经 guard 指纹校验，防误杀。
export class Launcher {
  constructor({ registry = new InstanceRegistry(), tunnelFactory = openTunnel, remotePathExists = sshPathExists, waitHttp = waitForHttp, tunnelReadyDelayMs = 800, recoveryDelaysMs = [1000, 2000, 4000, 8000, 16_000], recoveryCooldownMs = 30_000, stopRemoteFn = stopRemote, rememberAccessPort = () => {}, proxyFactory = createProxy, stopTermMs = STOP_TERM_MS, stopKillMs = STOP_KILL_MS } = {}) {
    this.registry = registry;
    this.tunnelFactory = tunnelFactory;
    this.remotePathExists = remotePathExists;
    this.waitHttp = waitHttp;
    this.tunnelReadyDelayMs = tunnelReadyDelayMs;
    this.recoveryDelaysMs = recoveryDelaysMs;
    this.recoveryCooldownMs = recoveryCooldownMs;
    this.stopRemoteFn = stopRemoteFn;
    this.rememberAccessPort = rememberAccessPort;
    this.proxyFactory = proxyFactory; // 可注入：预览代理的建立是异步的，竞态需要能被测试复现
    this.stopTermMs = stopTermMs;     // 可注入：测试不该为「忽略信号的子进程」真的等 5 秒
    this.stopKillMs = stopKillMs;
    this.procs = new Map(); // homeId -> { pid, port, url, proc, deeplink, kind }
    process.on('exit', () => {
      for (const inst of this.procs.values()) {
        this.#cancelRecovery(inst);
        if (inst.proc) inst.proc.kill();
      }
    });
  }

  // SIGTERM → 等 → SIGKILL → 等。返回「是否确认已退出」。
  //
  // 为什么必须等：kill() 只是**投递**信号。原先 stop() 发完信号就无条件
  // procs.delete + registry phase 'stopped' —— 若子进程忽略 SIGTERM（自装了处理器正在收尾、
  // 卡在系统调用里、或压根不是我们以为的那个程序），用户看到的是
  // 「已停止 / {ok:true,stopped:true}」而进程仍在监听端口（审查实测：lsof 显示同一个 pid 仍在
  // LISTEN、curl 仍返回 200），句柄却已经从 procs 里删掉 —— UI 连重试的机会都没有，
  // 端口要等到 hwb 退出才释放。所以：确认退出才算停掉，杀不掉就如实失败并保留句柄。
  async #terminate(inst, { termMs = this.stopTermMs, killMs = this.stopKillMs } = {}) {
    const proc = inst?.proc;
    // 没有子进程（adopted-local）或已经死了/pid 已被复用：无需动作。
    if (!fingerprint(proc)) return true;
    if (await this.#signalAndWait(proc, 'SIGTERM', termMs)) return true;
    log.warn('SIGTERM 后子进程未退出，升级为 SIGKILL', { pid: inst.pid, waitMs: termMs });
    if (await this.#signalAndWait(proc, 'SIGKILL', killMs)) return true;
    return !fingerprint(proc); // 超时后再按指纹复核一次（exit 可能刚发生）
  }

  // 先挂 'exit' 监听再发信号（真实 ChildProcess 的 exit 一定是异步 emit，但假句柄/已死的句柄
  // 可能同步就完成回收 —— 先挂监听 + 事后指纹复核，两种都能覆盖）。
  // 定时器**不 unref**：这是一段有界的等待（最多 3s + 2s），而「等子进程退出」正是进程该活着的原因；
  // 早先 unref 过一次，结果是「等待的 Promise 还没落地，事件循环就空了」。
  #signalAndWait(proc, signal, ms) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.off?.('exit', onExit);
        resolve(value);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), ms);
      proc.on('exit', onExit);
      try { proc.kill(signal); } catch { /* 可能刚好在这一刻退出 */ }
      if (!fingerprint(proc)) finish(true);
    });
  }

  // 退出前收尾：把所有受管子进程真的收掉。
  // process 'exit' 钩子里的 proc.kill() 是投递即返回的，而 process.exit() 之后事件循环不再运行 ——
  // 子进程若还没装上 SIGTERM 处理器（启动中）或忽略它，就会变成孤儿继续占着端口与 DSH_HOME
  // （审查实测：父进程没了，子进程仍在 LISTEN 并返回 200，没有任何人再管它）。
  async stopAll() {
    const list = [...this.procs.values()];
    const results = await Promise.all(list.map((inst) => this.#terminate(inst).catch(() => false)));
    const failed = results.filter((ok) => !ok).length;
    if (failed) log.warn('退出时有子进程未能停止', { total: list.length, failed });
    return failed;
  }

  status(homeId) {
    const inst = this.procs.get(homeId);
    // 直连已有实例（adopted-local）无子进程：只判「是否处于运行态」，不能靠 exitCode。
    if (!inst || inst.detached || inst.cancelled || (!inst.recovering && inst.proc && (inst.proc.exitCode !== null || inst.proc.signalCode != null))) return null;
    return { url: inst.url, iframeUrl: inst.iframeUrl, port: inst.port, pid: inst.pid, deeplink: inst.deeplink, kind: inst.kind, recovering: !!inst.recovering };
  }

  // 仅撤销 hwb 接入；不停止远端 dsh web。
  //
  // release=true 表示「这个实例正在被**移除**」，而不是「暂时断开」：此时必须把 hwb 自己
  // 拉起的本机 dsh web 也收掉。否则 store.removeHome() 之后该条目在任何 API/UI 里都不再可达，
  // 而进程会一直占着端口与 DSH_HOME，直到 hwb 本身退出（只有 process 'exit' 钩子会兜底杀）。
  async disconnect(home, { release = false } = {}) {
    const inst = this.procs.get(home.homeId);
    this.#cancelRecovery(inst);
    // 本机受管进程保留所有权，断开只撤销 hwb 接入，之后可以重新连接。
    if (inst?.previewProxy) await inst.previewProxy.close();
    if (inst?.proxy) await inst.proxy.close();
    if (inst?.kind === 'ssh' && fingerprint(inst.proc)) await this.#terminate(inst);
    if (inst?.kind === 'dsh-web' && !release) {
      inst.detached = true;
      delete inst.previewProxy;
      delete inst.previewPending;
      delete inst.iframeUrl;
    } else {
      if (release && inst?.proc && fingerprint(inst.proc)) {
        log.info('回收 hwb 拉起的本机 dsh web（移除实例，或连接建立失败）', { homeId: home.homeId, pid: inst.pid });
        const exited = await this.#terminate(inst);
        // 这里无法像 stop() 那样把句柄留着重试：实例记录可能马上被删掉，注册表也没有它的位置了。
        // 所以至少要**留痕**——否则进程会带着端口和 DSH_HOME 静默活下去，日志里什么都看不到。
        if (!exited) log.error('本机 dsh web 未能在 SIGTERM/SIGKILL 后退出，需手动处理', { homeId: home.homeId, pid: inst.pid, port: inst.port });
      }
      this.procs.delete(home.homeId);
    }
    this.registry.set(home.homeId, { phase: 'stopped', url: null, iframeUrl: null, port: null, pid: null });
  }

  async stop(home) {
    const inst = this.procs.get(home.homeId);
    this.#cancelRecovery(inst);
    // 远程:同时把远端 dsh web 停掉,而不是只拆隧道。
    let remoteStopError = null;
    if (home.hostType === 'remote') {
      try {
        await this.stopRemoteFn(home);
      } catch (e) {
        // 记下来：本地连接照常拆（用户要的是「断开」），但最后要如实告诉用户远端还活着 ——
        // 原先这里只 log.warn，用户看到的是「已停止」，而远端 dsh web 仍占着 remotePort 与 DSH_HOME。
        remoteStopError = e;
        log.error('停止远端 dsh web 失败（本地连接仍会拆掉）', { homeId: home.homeId, host: home.host, remotePort: home.remotePort, err: e?.message ?? String(e) });
      }
    }
    if (!inst) {
      this.registry.set(home.homeId, { phase: 'stopped', url: null, iframeUrl: null, port: null, pid: null });
      log.info('stop: 实例未在运行', { homeId: home.homeId });
      if (remoteStopError) throw new Error(`远端 dsh web 未能停止：${remoteStopError.message ?? remoteStopError}`);
      return false;
    }
    if (inst.proc) {
      // guard：仅当这是我们持有且仍存活的子进程（pid 未被复用）才 kill，避免误杀。
      if (fingerprint(inst.proc)) {
        log.info('stop: 终止子进程', { homeId: home.homeId, pid: inst.pid, signal: 'SIGTERM' });
        const exited = await this.#terminate(inst);
        if (!exited) {
          // 杀不掉就**不谎报**：保留句柄（UI 还能再点一次停止，端口归属也还清楚），注册表保持
          // 「仍在运行」——那才是事实。抛错让 API 回 500 并把原因带给用户。
          log.error('stop: 子进程在 SIGTERM/SIGKILL 之后仍未退出', { homeId: home.homeId, pid: inst.pid, port: inst.port });
          this.registry.set(home.homeId, { lastError: `子进程 ${inst.pid} 未能在 SIGTERM/SIGKILL 后退出，端口 ${inst.port ?? '-'} 仍被占用` });
          throw new Error(`未能停止实例进程（pid ${inst.pid}）：它忽略了 SIGTERM 与 SIGKILL，`
            + `端口 ${inst.port ?? '-'} 仍被占用。请手动处理：kill -9 ${inst.pid}`);
        }
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
    if (remoteStopError) throw new Error(`本地连接已断开，但远端 dsh web 未能停止：${remoteStopError.message ?? remoteStopError}`);
    // 返回值的语义：**true = 这次确实停掉了一个受管子进程**，false = 本来就没有受管子进程可停
    // （直连已有实例 adopted-local，或它早就退出了）。
    // 原先返回的是「子进程是否还活着」—— 而它在 kill 之后永远是 false，也就是**一次成功的停止
    // 反而回 false**，谁读这个字段都会被误导（前端目前不读它；API 的字段不该自相矛盾）。
    return !!(inst.proc && !fingerprint(inst.proc));
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
    catch (error) {
      // 这次 open 是我们**刚拉起**的连接（本地 = 新起的 dsh web 子进程），用户一次都没连上，
      // 所以失败时要连子进程一起收掉（release:true）。否则 disconnect 的「本机受管进程保留所有权」
      // 分支会把它标成 detached 留着：注册表说 stopped、status() 返回 null、监控报未运行，
      // 而子进程仍在监听那个端口（审查复现：pid 38693 仍 LISTEN 在 58316）—— 一个谁都管不到的僵尸。
      await this.disconnect(home, { release: true });
      throw error;
    }
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
      inst.previewPending ||= this.proxyFactory({ target: new URL(inst.url).origin, preview: true, port: remote ? home.accessPort || 0 : 0 });
      try { inst.previewProxy = await inst.previewPending; }
      catch (error) {
        if (error.code === 'EADDRINUSE') {
          // 端口提示只在**确实是那个端口**的冲突时才给：本机实例的 accessPort 是 undefined，
          // 原先把任何 EADDRINUSE 都改写成「本地端口 undefined 已被占用」，用户既不知道是哪个端口，
          // 也丢掉了真正的原因（实测就是这么打印出来的）。
          const hint = home.accessPort
            ? `本地端口 ${home.accessPort} 已被占用，请释放该端口或在实例设置中更换。`
            : '预览代理端口被占用（本机实例的端口由系统分配）。';
          throw new Error(`${hint}原始错误：${error.message}`);
        }
        throw error;
      }
      finally { inst.previewPending = null; }
      // 等 createProxy 落地这段时间里，实例可能已经被断开/移除/换掉了（disconnect 只关得掉
      // 「当时已经存在」的代理；previewPending 只能作废引用，管不到这个正在进行中的 Promise）。
      // 那样这个刚监听起来、又没人持有的端口会一直留到进程退出 —— 这里自己关掉它。
      if (inst.detached || inst.cancelled || this.procs.get(home.homeId) !== inst) {
        log.warn('预览代理就绪时实例已失效，回收该端口', { homeId: home.homeId, port: inst.previewProxy.port });
        await inst.previewProxy.close().catch(() => {});
        delete inst.previewProxy;
        delete inst.iframeUrl;
        return result;
      }
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

  // 连上之后必须验证**鉴权真的通过**，否则「连接成功」是假的。
  //
  // 现象（审查复现）：token 填错、或远端 dsh web 轮换了 token 时，open() 照样解析成功、
  // 注册表 phase=running、iframeUrl 指向的页面却是 401 栅栏，监控每 30s 报 running。
  // 根因：连接路径上的唯一存活性判据是 httpProbe —— 它的口径是 `status < 500`，401 也算「活着」
  // （对「远端端口上有没有 dsh web 在听」这类判断这是对的，对「用户点开能不能用」是错的）。
  // 这里用与 iframe **同一条入口**做一次真正的 token→cookie 交接：拿到 4xx 就明确失败，
  // 而不是把一个进不去的入口记成已连接。
  async #assertAuthorized(url) {
    let res;
    try {
      res = await authFetch(url);
    } catch (error) {
      throw new Error(`dsh web 鉴权探测失败：${error?.message ?? error}`);
    }
    try { await res.body?.cancel(); } catch { /* 释放失败不影响状态码判定 */ }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`dsh web 拒绝了这次连接（HTTP ${res.status}）：token 可能已失效或填错。`
        + '请在实例设置里重新填写 dsh web token（新版 dsh 的入口必须带 ?token=），或对该实例执行「重新连接」以重取 token。');
    }
    if (res.status >= 400) {
      throw new Error(`dsh web 入口返回 HTTP ${res.status}：这个地址可能不是 dsh web（或入口路径不对）。`);
    }
    return res.status;
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
    try {
      return await this.#spawnLocalDsh(home, true);
    } catch (error) {
      // `--no-open` 是**新版** dsh 才有的参数：remote.js 早就为此在远端路径里刻意不发它
      // （见那里的兼容说明），但本机路径一直硬发 —— 于是同一台旧版 dsh 远端能用、本机连不上，
      // 报错只有一句 `unknown option '--no-open'`。这里识别到就摘掉该参数重试一次；
      // 不带 `--no-open` 最多是多弹一个浏览器标签，远比连不上好。
      //
      // 判据必须覆盖**完整 stderr**（error.stderr），不能只看 message：commander 会把
      // `(Did you mean --open?)` 另起一行，message 的尾部于是不含 `--no-open`，
      // 只看 message 会在真实场景下永远不触发重试（测试里单行的假输出恰好能过）。
      const diagnostic = `${error.message}\n${error.stderr ?? ''}`;
      if (!/--no-open/.test(diagnostic) || !/unknown option|unrecognized|invalid option|did you mean/i.test(diagnostic)) throw error;
      log.warn('本机 dsh 不支持 --no-open，去掉该参数重试一次', { homeId: home.homeId });
      return await this.#spawnLocalDsh(home, false);
    }
  }

  // noOpen=false 时不传 --no-open（兼容不认识该 flag 的旧版 dsh）。
  async #spawnLocalDsh(home, noOpen) {
    const port = await freePort();
    // 用裸 `dsh web` 别名启动（新版等价于 `--profile web`，旧版 v0.1.x 原生支持），显式 `--port`。
    // 本机默认带 `--no-open`，避免 hwb 之外再弹一个浏览器标签。
    const args = ['web', '--port', String(port), ...(noOpen ? ['--no-open'] : [])];
    const proc = spawn('dsh', args, {
      env: { ...process.env, DSH_HOME: home.homePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    const lastStderr = (n = 8) => stderr.trim().split('\n').slice(-n).join('\n');
    // spawn 的失败（PATH 里没有 dsh、dsh 不可执行）是**异步**以 'error' 事件上报的，
    // 而且它会绕过 'exit'；没有监听就变成 uncaughtException → installCrashHandlers 直接
    // process.exit(1)，连带 SIGTERM 掉所有托管的 dsh web 子进程。挂上监听后 Node 会把
    // proc.exitCode 置为 -2，下方的 waitForHttp 轮询据此立即失败，走既有的错误分支，
    // 用户看到的是「dsh web did not come up」，而不是整个 hwb 消失。
    proc.on('error', (e) => { stderr += `spawn error: ${e.message}\n`; });
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
      const wasCurrent = this.procs.get(home.homeId) === inst;
      if (wasCurrent) this.procs.delete(home.homeId);
      // 子进程没了，就必须让**共享注册表**知道 —— `monitor.get()`（API/界面都读它）在下一轮
      // 心跳（最多 30s）之前会一直报 running + 旧 pid/url：卡片显示「已连接」、标签页圆点是绿的、
      // iframe 指向一个已经没人监听的端口，服务端「已连接实例」的过滤也照样把它算进去。
      // 对照：ssh 隧道退出那条路径早就会把 phase 置为 degraded 并调度恢复，本机子进程这条漏了。
      if (wasCurrent && !inst.detached) {
        this.registry.set(home.homeId, { phase: 'stopped', url: null, iframeUrl: null, port: null, pid: null });
      }
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
      await this.#assertAuthorized(url);
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
      // 消息里带上 stderr 的**最后几行**，而不是只带最后一行：commander 在选项名相近时会把
      // 建议另起一行输出（`error: unknown option '--no-open'` + `(Did you mean --open?)`），
      // 只取最后一行就等于把「unknown option」这个关键判据丢掉了（见 #openLocal 的重试判断）。
      const tail = stderr ? stderr.trim().split('\n').slice(-3).map((l) => l.trim()).join(' | ') : '';
      const failure = new Error(`dsh web did not come up: ${e.message}${tail ? ` — ${tail}` : ''}`);
      // 完整 stderr 挂到 error 上：调用方（兼容重试）要按内容判断，不该靠 message 里被截断的片段。
      failure.stderr = stderr;
      throw failure;
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
    // 鉴权必须在这里就验掉：waitForHttp 只看 `status < 500`，一个 401 栅栏页面同样「可达」——
    // 用户手填的 token 写错时，原先会得到「已连接」，而 iframe 里是 401（审查复现）。
    try {
      await this.#assertAuthorized(url);
    } catch (error) {
      this.procs.delete(home.homeId);
      this.registry.set(home.homeId, { phase: 'stopped', lastError: error.message });
      log.error('直连本机 dsh web 鉴权失败', error, { homeId: home.homeId, port });
      throw error;
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
    const attempts = inst.recoveryAttempts ?? 0;
    // 先按快退避把常见抖动救回来；预算用尽后转入**慢速常驻重试**，而不是彻底停下。
    // 原先预算用尽就直接 return，什么状态都不清：recovering 永远为真，status() 因此跳过
    // 「进程已死」判断、持续吐出早就失效的 URL，Monitor 走 recovering 分支既不再探测也不安排
    // 重连 —— 网络恢复后实例永远不会自愈，而且 routes.js 会把「换一条通道连同一实例」判成
    // 「已被占用」直接 409，用户连绕过去都做不到。
    const delayMs = attempts < this.recoveryDelaysMs.length
      ? this.recoveryDelaysMs[attempts]
      : this.recoveryCooldownMs;
    if (attempts === this.recoveryDelaysMs.length) {
      log.warn('SSH 重连快退避已用尽，转为慢速常驻重试', {
        homeId: home.homeId, attempts, cooldownMs: this.recoveryCooldownMs,
      });
    }
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
      // 鉴权验证必须在 `connected = true` 之前：远端 dsh web 轮换了 token（或手填的 token 已失效）时，
      // 隧道与反代都是通的、httpProbe 也返回「活着」，但入口只会回 401 —— 原先照记 running。
      await this.#assertAuthorized(inst.url);
      assertCurrent();
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
    // 提前绑定：spawn 失败（PATH 里没有 dsh）时 'exit' **永远不会触发**，只有 'error' 会。
    // 只等 'exit' 的话这个 Promise 要挂到 timeoutMs 才 settle，白白拖住 Promise.all，
    // 而调用方其实已经能从 exitCode(-2) 判断失败并抛出更准确的错误。
    const onError = () => settle(null);
    const settle = (fragment) => {
      clearTimeout(timer);
      proc.stdout.off('data', onData);
      proc.off('exit', onExit);
      proc.off('error', onError);
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
    proc.on('error', onError);
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
