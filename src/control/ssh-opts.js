import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

// —— SSH 连接策略（统一出口，§5.3 隧道 / §5.4 远端生命周期 / M6 探测共用）——
//
// 背景（实测 2026-09）：经 tun + EasyConnect 访问的远端（如 dgx21.tun）建立一条 SSH
// 会话需 11.7–14.0s（TCP+认证全算上），远超原硬编码的 `ConnectTimeout=10`。后果是：
//   · remote.js 的脚本化 `ssh host bash -s` 每次都 255 失败（"connect to host ... timed out"）；
//   · 用户在终端手动 ssh（无超时上限）却能成功 —— 表现为「手动能连、hwb 连不上」。
// 同时远端掉线/漫游时，长连接缺少保活会导致隧道与探测静默僵死。
//
// 因此这里做两层处理：
//   ① 连接层：放宽 ConnectTimeout（默认 30s，高延迟链路留足重传余量）；
//   ② 保活层：ServerAliveInterval/CountMax + TCPKeepAlive，让已建连接在链路抖动时不被静默丢弃。
//
// 另加 ③ 复用层：ControlMaster 多路复用。一条常驻 master 承载后续所有 ssh 调用
// （探测 / 建隧道 / 抓 token），既把每次 12s 的握手摊销成一次性成本，也让「保活」真正落在
// 一条长连接上，而不是每次点击都新建一条。可用 HWB_SSH_MUX=0 关闭。
//
// 所有阈值均可经环境变量覆盖，便于按链路调参而无需改码：
//   HWB_SSH_CONNECT_TIMEOUT（秒，默认 30）
//   HWB_SSH_ALIVE_INTERVAL（秒，默认 15）
//   HWB_SSH_ALIVE_COUNT_MAX（默认 4）
//   HWB_SSH_MUX（1/0，默认 1）

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envEnabled(name, fallback = true) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

// 复用套接字目录：默认放 ~/.ssh（路径短且不依赖 TMPDIR）。macOS 对 unix socket 路径有
// 104 字节硬上限，而 TMPDIR 形如 /var/folders/xx/xxxx/T/ = 约 49 字节，再叠加 ssh 展开的
// %C（SHA1 十六进制 40 字节）必然超限 —— 实测报错：
//   ControlPath too long ('/var/folders/.../hwb-ssh-mux/cm-<40hex>' >= 104 bytes)
// 故这里改用「短哈希」而非 %C，并对最终长度做校验，超限则退回不复用（绝不因此连不上）。
const MUX_DIR_ENV = 'HWB_SSH_MUX_DIR';
const CONTROL_PATH_MAX = 100; // 留 4 字节余量给 104 上限

export function muxDir() {
  const dir = process.env[MUX_DIR_ENV] || join(homedir(), '.ssh', 'hwb-mux');
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* 创建失败则退回不复用 */ }
  return dir;
}

export function muxEnabled() {
  return envEnabled('HWB_SSH_MUX', true);
}

// 按主机名做【短】稳定哈希：同一 host 始终映射到同一套接字（可复用），
// 且长度可控。12 位十六进制碰撞概率极低；即便碰撞也只是两条主机共享连接池，不影响正确性。
export function muxPath(host = '') {
  const short = createHash('sha256').update(String(host || 'default')).digest('hex').slice(0, 12);
  return join(muxDir(), `cm-${short}`);
}

// 判定复用套接字路径是否在平台限制内；超限时调用方应放弃复用（见 sshOpts）。
export function muxPathUsable(p) {
  return typeof p === 'string' && p.length <= CONTROL_PATH_MAX;
}

// 统一的 ssh -o 参数列表（不含目标 host，可直接铺进 spawn/execFile 的 argv）。
// host 传了就带上按主机隔离的复用套接字；不传则跳过复用（例如 ssh -G 只解析配置）。
export function sshOpts({ host = null, mux = muxEnabled() } = {}) {
  const opts = [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${envInt('HWB_SSH_CONNECT_TIMEOUT', 30)}`,
    // 保活：链路空闲 15s 发一次探测，连续 4 次无响应（约 60s）才判定断开。
    '-o', `ServerAliveInterval=${envInt('HWB_SSH_ALIVE_INTERVAL', 15)}`,
    '-o', `ServerAliveCountMax=${envInt('HWB_SSH_ALIVE_COUNT_MAX', 4)}`,
    '-o', 'TCPKeepAlive=yes',
  ];
  if (host && mux) {
    const path = muxPath(host);
    // 路径超平台上限就放弃复用（而不是让 ssh 直接报错连不上）。
    if (muxPathUsable(path)) {
      opts.push(
        // auto：已有 master 就复用，没有就顺手建一条常驻 master（ControlPersist=300
        // 让它在最后一个客户端退出后仍保留 5 分钟，把后续点击的握手成本降到 0）。
        '-o', 'ControlMaster=auto',
        '-o', `ControlPath=${path}`,
        '-o', 'ControlPersist=300',
      );
    }
  }
  return opts;
}

// 连接级瞬时故障（值得重试）的 stderr 特征：握手失败、链路不可达、保活判死。
// 注意只用于「快速失败」场景 —— 调用方需同时确认耗时很短，避免把正常长任务误判为可重试。
const TRANSIENT_SSH = /(?:: connect to host .* timed out|Connection timed out|Connection refused|No route to host|Network is unreachable|Operation timed out|Connection reset by peer|Broken pipe|Shared connection to .* closed|mux_client_|Control socket .* already exists, disabling multiplexing)/i;

export function isTransientSshError(stderr) {
  return TRANSIENT_SSH.test(String(stderr || ''));
}

// 按指数退避重试一次「连接级」失败。返回 { value, attempts }；全部失败则抛出最后一次错误。
// run 需返回 { ok, stderr, elapsedMs } 形态之外的判断由 shouldRetry 决定。
export async function withConnectRetry(attempt, { retries = 2, delaysMs = [1500, 4000] } = {}) {
  let last;
  for (let i = 0; i <= retries; i += 1) {
    const r = await attempt(i);
    if (r.ok) return r;
    last = r;
    // 仅在「连接级瞬时故障」且「失败得很快」时重试：慢失败多半是真断了，重试无益且拖时间。
    const transient = isTransientSshError(r.stderr) && (r.elapsedMs ?? 0) < 40_000;
    if (!transient || i === retries) return r;
    await new Promise((res) => setTimeout(res, delaysMs[Math.min(i, delaysMs.length - 1)]));
  }
  return last;
}

export const sshPolicySummary = () => ({
  connectTimeout: envInt('HWB_SSH_CONNECT_TIMEOUT', 30),
  keepAliveInterval: envInt('HWB_SSH_ALIVE_INTERVAL', 15),
  keepAliveCountMax: envInt('HWB_SSH_ALIVE_COUNT_MAX', 4),
  multiplexing: muxEnabled(),
  muxDir: muxEnabled() ? muxDir() : null,
});
