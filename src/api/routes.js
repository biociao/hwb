import { openWorkspaceInFinder } from '../lib/open-workspace.js';
import { normalizeEndpoints, endpointPatch, assertSshHost } from '../lib/endpoints.js';
import { normalizeAccessPort } from '../lib/access-port.js';
import { instanceKey } from '../web/instance-state.js';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseMultipart } from '../lib/multipart.js';
import { logger } from '../lib/logger.js';
import { readFilePreview, resolveUploadDir, writeUpload, UPLOAD_BYTES, sessionWorkspace } from '../lib/file-preview.js';

// 实例对象出站前的整形：去掉 dsh 的 token。
//
// token 是**控制凭据**（持有它 = 持有那个 dsh 实例：能执行 shell、写文件），而这个 API 在回环上
// 是**没有鉴权**的：任何本机进程 `curl http://127.0.0.1:<port>/api/homes` 就能拿到全部实例的 token
// （实测就是这样拿到明文 SUPER-SECRET-LAUNCH-TOKEN 的）。界面并不需要它 —— 带 token 的 iframe 入口
// 由 `POST /homes/{id}/open` 现取现用（`inst.iframeUrl || inst.url`），
// 而部分更新（PATCH）只在客户端**显式**传 token 时才改它，所以读接口不再回传不会破坏任何流程。
// endpoints[] 里的 token 是**同一类凭据**（每个连接端点一个），原先一并回传 —— 理由是端点编辑器
// 需要它做预填，否则保存时会把 token 抹掉。现在改成「不回传 + 留空即保持不变」：
// 出站时把值换成 `tokenSet: true`，更新时客户端不传 token 就沿用已存的那个（见 mergeEndpointTokens）。
// 这样既不再把凭据交给浏览器，也不会让「打开设置再保存」变成一次静默清除。
function publicHome(home) {
  if (!home || typeof home !== 'object') return home;
  const { token, endpoints, ...rest } = home;
  return {
    ...rest,
    endpoints: Array.isArray(endpoints)
      ? endpoints.map(({ token: epToken, ...ep }) => ({ ...ep, tokenSet: Boolean(epToken) }))
      : endpoints,
  };
}

// 「留空即保持不变」的合并语义（端点 token）。
// 客户端不再收到 token，所以它提交的端点里通常**没有** token 字段：这种情况沿用已存的值。
// 要清除必须显式表达：`tokenClear: true`（或显式传 `token: ''`）。
function mergeEndpointTokens(input, existing = []) {
  if (!Array.isArray(input)) return input;
  const byId = new Map(existing.map((e) => [e?.id, e]));
  return input.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const prev = entry.id ? byId.get(entry.id) : null;
    if (entry.tokenClear === true) return { ...entry, token: null };
    if (!Object.hasOwn(entry, 'token') || entry.token === undefined) {
      return { ...entry, token: prev?.token ?? null };
    }
    return entry;
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

// 查询参数里的数值必须**带上下界**解析。
// `Number(x) || fallback` 只挡得住 0/NaN/'abc'，挡不住 `?days=1e9` —— 那会一路传到
// `new Date(Date.now() - days * 86_400_000).toISOString()`，超出 ECMAScript 日期范围后
// toISOString 抛 RangeError，请求变成 500（实测 /api/projects/recent?days=1e9）。
function numParam(raw, fallback, min, max) {
  // 参数**缺失**时必须走 fallback，不能落进下面的数值分支：
  // `Number(null)` 是 0（有限数），会被夹到 min —— 于是「不传 days」变成 days=1，
  // 默认窗口从 7 天缩成 1 天（这是真踩到过的：/api/projects/recent 少了 7 天内的空工作区）。
  if (raw === null || raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

const JSON_BODY_LIMIT = 64 * 1024;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// 带 code 的错误：路由的 catch 需要据此区分「包太大」与「JSON 非法」，否则前者的真实原因
// 会被统一成无效 JSON，前端只能提示一个误导性的错误。
const bodyTooLarge = () => Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' });

async function readJsonBody(req) {
  // Content-Length 先判：能在读第一个字节之前就拒绝（也避免读一个明知会超限的大包）。
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > JSON_BODY_LIMIT) throw bodyTooLarge();
  // 显式按 UTF-8 解码：异步迭代器给的是 Buffer，`raw += chunk` 会对**每个 TCP 分片**单独
  // toString('utf8')，一个多字节字符（中文、emoji）若正好被分片切开就会变成 U+FFFD——而且
  // 结果仍是合法 JSON，所以只会静默存进一个乱码的别名/host 才被发现。setEncoding 让
  // StringDecoder 跨分片拼接，边界由它负责。
  req.setEncoding?.('utf8');
  let raw = '';
  let bytes = 0;
  for await (const chunk of req) {
    // 边收边限：没有 Content-Length（chunked）时也不能把整个包读进内存。
    // 注意**不要** req.destroy()：那会把 socket 一起销毁，调用方随后的 400 响应写不出去，
    // 客户端只能看到 EPIPE，反而分不清「包太大」和「服务已死」。这里只是停止读取，
    // 由 Node 在响应写完后自行关闭这条 keep-alive 连接。
    bytes += Buffer.byteLength(chunk);
    if (bytes > JSON_BODY_LIMIT) throw bodyTooLarge();
    raw += chunk;
  }
  return raw ? JSON.parse(raw) : {};
}

// 统一把 readJsonBody 的失败翻译成 400（包太大 → 原样透出，JSON 非法 → 固定文案）。
// 返回 null 表示已响应，调用方直接 return 即可。
async function readJsonBodyOr400(req, res) {
  try {
    return await readJsonBody(req);
  } catch (error) {
    send(res, 400, { error: error.code === 'BODY_TOO_LARGE' ? error.message : 'invalid JSON body' });
    return null;
  }
}

// 跨站写保护。hwb 只监听 127.0.0.1 且无鉴权（架构文档 §11），所以浏览器里的任意页面都能
// 向本机端口发请求；又因为 Content-Type 为 text/plain / multipart/form-data 的请求属于 CORS
// **简单请求**（不触发预检、也因此拿不到 CORS 拒绝），不能只靠「浏览器会不会拦住」来兜底。
// 因此凡改变状态的方法一律要求同站来源：Sec-Fetch-Site 明确 cross-site 时拒绝；带 Origin 时
// 必须与本机 Host 完全一致。非浏览器客户端（curl / 测试）两个头都没有，照常放行。
function sameSiteRequest(req) {
  const headers = req.headers ?? {};
  if (headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = headers.origin;
  if (origin && origin !== `http://${headers.host}`) return false;
  return true;
}

function dshHomeInfo(homePath) {
  const exists = existsSync(homePath) && statSync(homePath).isDirectory();
  return {
    path: homePath,
    exists,
    looksLikeDshHome: exists && existsSync(path.join(homePath, 'storages', 'workspace.json')),
  };
}

// remoteExec：远端实例的 ssh 执行器，缺省用真实的 sshBash。抽成依赖是为了让「远端实例上传」
// 这条链路能在测试里被真正走一遍 —— 它此前从未被路由级测试覆盖，于是藏着一个让整条远端
// 上传通道（分片 + 远端合并）完全不可达的缺陷（见下面的注释）。
export function createRouter({ store, indexer, hub, launcher, monitor, quota, logApi, remoteExec, usageTtlMs = 10_000, maxConcurrentUploads = 1 }) {
  const connecting = new Set();
  // 上传并发上限（见 upload 路由里的说明）。默认 1：最坏内存 ≈ 单次上限（256 MiB → ~1.1 GiB）。
  const MAX_CONCURRENT_UPLOADS = maxConcurrentUploads;
  let uploadsInFlight = 0;
  // 定向重索引常常是 fire-and-forget（远程要等 SSH 超时，不能阻塞响应）。
  // 但「不 await」不等于「不管」：返回的 promise 一旦拒绝就是未处理拒绝，
  // 会被 crash handler 记成 fatal 并掩盖真正的失败原因。这里统一吞掉——
  // 索引本身已经把失败写进 homes.status/degraded 并通过 SSE 广播出去了。
  // `/api/usage` 是**八个同步 SQLite 聚合**（node:sqlite 没有异步接口），而整个服务是单线程的：
  // 这段时间里所有 HTTP 请求、SSE 推送、30s 心跳全部停住。真实规模下实测（40k 会话）合计
  // **~330ms**；而前端原先**每次渲染都取一次用量**，渲染又由 SSE 驱动（每 3s 一次）——
  // 于是「开着一个大库的工作台」就是每 3 秒冻一次。索引层已经是覆盖索引
  // （SEARCH sessions USING COVERING INDEX idx_sessions_activity），慢的是逐行 json_extract。
  //
  // 这里加一层很短的 TTL 记忆：同一组参数 10s 内只算一次，多标签页/多客户端共享同一份结果，
  // 把请求频率直接压到 1/10。用量面板统计的是历史，滞后 10 秒无感；代价是尖峰仍在
  // （每 10s 一次 ~330ms，不再是每 3s 一次）。要彻底消除尖峰得把 token 总量落成列（去 json_extract），
  // 那是一次 schema 迁移，留作后续工作 —— 这里先把它从「常态卡顿」降到「偶发尖峰」。
  const USAGE_TTL_MS = usageTtlMs;
  const USAGE_MEMO_MAX = 32;
  const usageMemo = new Map();   // `${days}:${hours}` -> { at, version, body }
  const usagePayload = (days, hours) => {
    const key = `${days}:${hours}`;
    const version = store.dataVersion?.() ?? 0;
    const hit = usageMemo.get(key);
    // 两级判据：①数据版本没变 → 缓存**永远有效**（空闲的仪表盘不必为同一份数据反复跑聚合）；
    // ②版本变了但还在 TTL 内 → 仍然复用，把「实例在跑、每 3s 都有实时写入」时的聚合频率压在 1/10s。
    // 只有「版本变了且 TTL 也过了」才真跑那 8 个同步聚合。
    if (hit && (hit.version === version || Date.now() - hit.at < USAGE_TTL_MS)) return hit.body;
    const body = {
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
    };
    if (usageMemo.size >= USAGE_MEMO_MAX) usageMemo.clear();   // 键的取值空间很小，防的是异常调用
    usageMemo.set(key, { at: Date.now(), version, body });
    return body;
  };
  // 实例集合/名称变了（新增、移除、改别名），缓存的 body 就不再是同一份数据：
  // 「按实例」维度会继续显示一个**已经被移除**的实例，最多 10s（客户端还有一层 15s，合计更久）。
  // 这类写操作很少，直接整表清空最省心 —— 代价是紧随其后的一次 /api/usage 会真跑一遍聚合。
  const dropUsageMemo = () => usageMemo.clear();

  const reindexInBackground = (homeId) => {
    try {
      // Promise.resolve(...) 同时容纳「返回 promise」与「返回 undefined」两种实现；
      // 同步抛出也一并吞掉 —— 这是后台优化，不该反过来把用户的操作请求打成 5xx。
      Promise.resolve(indexer.reindexNow(homeId)).catch(() => {});
    } catch { /* 同上 */ }
  };
  return async function route(req, res, url) {
    const { pathname, searchParams } = url;

    // 所有写操作统一在此拦截，避免每个路由各写一份、漏一个就留一个 CSRF 口子。
    if (MUTATING_METHODS.has(req.method) && !sameSiteRequest(req)) {
      send(res, 403, { error: '不允许跨站请求' });
      return;
    }

    const finder = pathname.match(/^\/api\/homes\/([0-9a-f]{16})\/open-workspace$/);
    if (req.method === 'POST' && finder) {
      try {
        const body = await readJsonBody(req);
        const home = store.getHome(finder[1]);
        const workspace = home && store.listWorkspaces({ homeId: home.homeId }).find((w) => w.workspaceId === body.workspaceId);
        await openWorkspaceInFinder(home, workspace);
        send(res, 200, { ok: true });
      } catch (e) { send(res, 400, { error: e.message }); }
      return;
    }

    const preview = pathname.match(/^\/api\/homes\/([0-9a-f]{16})\/(preview|download)$/);
    if (req.method === 'GET' && preview) {
      res.setHeader('Cache-Control', 'no-store');
      if (req.headers['sec-fetch-site'] === 'cross-site') {
        send(res, 403, { error: '不允许跨站读取文件' }); return;
      }
      const home = store.getHome(preview[1]);
      if (!home) { send(res, 404, { error: '实例不存在' }); return; }
      const workspaces = store.listWorkspaces({ homeId: home.homeId });
      const sessionId = searchParams.get('sessionId');
      const workspace = sessionId
        ? sessionWorkspace(workspaces, store.getSession(home.homeId, sessionId))
        : workspaces.find((w) => w.workspaceId === searchParams.get('workspaceId'));
      if (!workspace?.path) { send(res, 400, { error: '当前会话尚未关联可用的 project 工作区，请先在 dsh 中打开项目会话' }); return; }
      try {
        if (preview[2] === 'download') {
          const result = await readFilePreview(home, workspace.path, searchParams.get('path') || '.', undefined, { download: true });
          const name = encodeURIComponent(path.basename(result.path)).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16));
          // 本机下载回的是 Buffer（见 readLocalPreview：避免 base64 + JSON 的两层同尺寸副本），
          // 远端下载经 ssh 传回，仍是 base64 字符串。两条路径都在这里收敛成响应用的字节。
          const bytes = Buffer.isBuffer(result.data) ? result.data : Buffer.from(result.data, 'base64');
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length,
            'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${name}`, 'X-Content-Type-Options': 'nosniff' });
          res.end(bytes);
          return;
        }
        send(res, 200, { ...await readFilePreview(home, workspace.path, searchParams.get('path') || '.'),
          workspace: { workspaceId: workspace.workspaceId, title: workspace.title, path: workspace.path } });
      } catch (e) { send(res, 400, { error: e.message }); }
      return;
    }

    // 上传：把本地文件写进「当前预览目录」。只接受 multipart 单文件字段，落盘位置完全由服务端
    // 依 workspace + 已校验目录决定（前端只给文件名），同名文件一律改名，不覆盖已有文件。
    const upload = pathname.match(/^\/api\/homes\/([0-9a-f]{16})\/upload$/);
    if (req.method === 'PUT' && upload) {
      res.setHeader('Cache-Control', 'no-store');
      // 上传并发闸门。解析器是**同步契约**，路由只能把整包 body 攒在内存里
      // （实测：256 MiB 单次上传峰值 RSS 1.12 GiB ≈ 4.4×；规模审查测得 4 个满额并发 ⇒ ~4.4 GiB，
      // 而 hwb 没有设置堆上限 ⇒ 容器直接 OOM）。把并发压到 1 之后，最坏情况回到「一次上传的大小」；
      // 超出的请求立刻 503 + 一条 warn（不排队：排队意味着更多内存被同一个进程持有）。
      if (uploadsInFlight >= MAX_CONCURRENT_UPLOADS) {
        logger('api').warn('上传并发已达上限，拒绝新上传', { inFlight: uploadsInFlight, limit: MAX_CONCURRENT_UPLOADS });
        send(res, 503, { error: `已有 ${uploadsInFlight} 个上传在进行，请稍后重试` });
        return;
      }
      uploadsInFlight++;
      // **整个处理过程**都在 try/finally 里：闸门的递增之后有若干条提前返回（实例不存在、
      // 没有可用工作区、不是 multipart、路径非法）。原先只有最内层 parse+write 的 finally 会减，
      // 于是**一个**参数不合法的请求就会把计数器永久顶到上限 —— 此后所有上传都 503，
      // 直到进程重启（自查本轮改动时发现的：这类「提前 return 漏减引用计数」是经典的自伤）。
      try {
      const home = store.getHome(upload[1]);
      if (!home) { send(res, 404, { error: '实例不存在' }); return; }
      const workspaces = store.listWorkspaces({ homeId: home.homeId });
      const sessionId = searchParams.get('sessionId');
      const workspace = sessionId
        ? sessionWorkspace(workspaces, store.getSession(home.homeId, sessionId))
        : workspaces.find((w) => w.workspaceId === searchParams.get('workspaceId'));
      if (!workspace?.path) { send(res, 400, { error: '当前会话尚未关联可用的 project 工作区，请先在 dsh 中打开项目会话' }); return; }
      const type = String(req.headers['content-type'] || '');
      const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type)?.slice(1).find(Boolean);
      if (!/^multipart\/form-data/i.test(type) || !boundary) { send(res, 400, { error: '上传请求须为 multipart/form-data' }); return; }
      const dir = searchParams.get('dir') || searchParams.get('path') || '.';
      if (dir.includes('\0') || dir.length > 4096) { send(res, 400, { error: '文件路径无效' }); return; }
      const parts = [];
      let current = null;
      try {
        // 目录先解析一次：目标不存在/越界时立刻回错，不必先把整包读完再失败。
        // **但只对本地实例做。** resolveUploadDir 走的是本地 fs，而远端实例的 workspace.path 是
        // **远端主机上**的路径（由 indexRemoteHome 通过 ssh 读回来的），拿它去本地 realpath
        // 必然 ENOENT —— 于是「远端上传」100% 返回 400（实测：本机实例 200 / 远端实例
        // `400 ENOENT: realpath '/home/bot/projects/remote-project'`），file-preview.js 里那套
        // 加固过的远端分片上传（REMOTE_CHUNK_PY / REMOTE_FINISH_PY）成了谁都走不到的死代码。
        // 远端的目标目录校验由 REMOTE_FINISH_PY 在**远端主机上**用 realpath+commonpath 完成，
        // 那才是有效校验；这里只负责本地实例。
        if (home.hostType !== 'remote') await resolveUploadDir(workspace.path, dir);
        await parseMultipart(req, {
          boundary,
          maxBytes: UPLOAD_BYTES,
          // 解析出的文件名（浏览器可能带上目录前缀）交给 writeUpload 再规范化一次。
          // 注意这里是**攒在内存里**：解析器的 write(chunk) 是同步契约，而落盘（uploader.write）
          // 是异步的，路由无法在回调里 await。实测 64 MiB 上传 → 进程 RSS 峰值 +202 MiB（≈3×），
          // 上限 256 MiB 时按同一比例 ≈800 MiB 峰值。有界、短暂，但**不是**恒定内存；
          // 要改成真流式需要让解析器支持异步写入端。multipart.js 头部与 CHANGELOG 的 Notes 有同一条订正。
          onFileStart(name) { current = { name, chunks: [] }; parts.push(current); return true; },
          write(chunk) {
            if (!current) throw new Error('上传请求格式无效');
            current.chunks.push(chunk);
          },
        });
        const result = await writeUpload(home, workspace.path, dir, parts, remoteExec);
        const listing = await readFilePreview(home, workspace.path, dir, remoteExec);
        send(res, 200, { ok: true, dir: result.dir, files: result.files,
          listing: listing.kind === 'directory' ? listing : null });
      } catch (e) { send(res, 400, { error: e.message }); }
      } finally { uploadsInFlight--; }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      hub.handle(req, res);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/homes') {
      const homes = store.listHomes().map((h) => ({ ...publicHome(h), runtime: monitor.get(h.homeId) }));
      send(res, 200, { homes });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/homes/detect') {
      send(res, 200, dshHomeInfo(path.join(homedir(), '.dsh')));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/homes') {
      const body = await readJsonBodyOr400(req, res);
      if (body === null) return;
      if (body.endpoints !== undefined) {
        try {
          body.endpoints = normalizeEndpoints(mergeEndpointTokens(body.endpoints, []), body.hostType || 'local');
          const first = body.endpoints[0];
          if (first) Object.assign(body, endpointPatch({ hostType: body.hostType || 'local' }, first));
        } catch (error) { send(res, 400, { error: error.message }); return; }
      }
      const alias = typeof body.alias === 'string' && body.alias.trim() ? body.alias.trim() : null;
      let accessPort;
      try { if (body.accessPort !== undefined) accessPort = normalizeAccessPort(body.accessPort); }
      catch (error) { send(res, 400, { error: error.message }); return; }
      if (accessPort && !(body.hostType === 'remote' || (body.host && body.remotePort))) {
        send(res, 400, { error: '本机实例直接使用 dsh 服务端口，无需本地接入端口' }); return;
      }
      if (accessPort && store.listHomes().some(h => h.accessPort === accessPort)) {
        send(res, 409, { error: `本地端口 ${accessPort} 已被另一个实例保留` }); return;
      }

      // SSH 远程实例：host + remotePort（远端 dsh web 监听端口）。
      if (body.hostType === 'remote' || (body.host && body.remotePort)) {
        const host = typeof body.host === 'string' && body.host.trim() ? body.host.trim() : null;
        const remotePort = Number(body.remotePort);
        if (!host || !Number.isInteger(remotePort) || remotePort <= 0) {
          send(res, 400, { error: 'remote instance requires a non-empty host and a numeric remotePort' });
          return;
        }
        // 必须在 registerHome 之前校验：registerHome 先 INSERT homes，随后 updateHomeConfig
        // 才做端点校验；校验放在后面会变成「返回 500、但实例已经建好了」——
        // 用户看到添加失败，实例却出现在列表里且索引永远失败，只能手工删。
        try { assertSshHost(host); } catch (error) { send(res, 400, { error: error.message }); return; }
        const remoteHome = typeof body.remoteHome === 'string' && body.remoteHome.trim() ? body.remoteHome.trim() : null;
        const remoteCmd = typeof body.remoteCmd === 'string' && body.remoteCmd.trim() ? body.remoteCmd.trim() : null;
        const remoteLog = typeof body.remoteLog === 'string' && body.remoteLog.trim() ? body.remoteLog.trim() : null;
        // 手填 token（自服务直连）：用户已更新远端 dsh 后把 token 填进配置，hwb 直接连接。
        const token = typeof body.token === 'string' && body.token.trim() ? body.token.trim() : null;
        const homePath = `ssh://${host}:${remotePort}`;
        const serverId = typeof body.serverId === 'string' ? body.serverId.trim() || null : null;
        const homeId = store.registerHome({ homePath, alias, serverId, endpoints: body.endpoints, activeEndpointId: body.activeEndpointId, hostType: 'remote', host, remotePort, remoteHome, remoteCmd, remoteLog, token, accessPort });
        // 注册后立即触发一次该实例的索引（不等结果：远程走 SSH，不可达时要等超时，
        // 同步等待会卡住注册响应；索引完成后会广播 index:updated，前端经 SSE 自动刷新）。
        reindexInBackground(homeId);
        dropUsageMemo();   // 同上：新实例立刻参与「按实例」维度
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
      const homeId = store.registerHome({ homePath, alias, hostType: 'local', localPort, token, endpoints: body.endpoints, activeEndpointId: body.activeEndpointId, accessPort });
      const results = await indexer.reindexNow(homeId);
      dropUsageMemo();   // 新实例可能已经带了一批会话（接入已有 dsh），「按实例」维度要立刻反映
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
      const body = await readJsonBodyOr400(req, res);
      if (body === null) return;
      if (connecting.has(instanceKey(home))) {
        send(res, 409, { error: '请先断开连接再修改实例配置' });
        return;
      }
      const patch = {};
      if (body.accessPort !== undefined) {
        try { patch.accessPort = normalizeAccessPort(body.accessPort); }
        catch (error) { send(res, 400, { error: error.message }); return; }
        if (home.hostType !== 'remote' && patch.accessPort) {
          send(res, 400, { error: '本机实例直接使用 dsh 服务端口，无需本地接入端口' }); return;
        }
        if (patch.accessPort && store.listHomes().some(h => h.homeId !== home.homeId && h.accessPort === patch.accessPort)) {
          send(res, 409, { error: `本地端口 ${patch.accessPort} 已被另一个实例保留` }); return;
        }
      }
      if (body.endpoints !== undefined) {
        try {
          patch.endpoints = normalizeEndpoints(mergeEndpointTokens(body.endpoints, home.endpoints), home.hostType);
        }
        catch (error) { send(res, 400, { error: error.message }); return; }
      }
      if (typeof body.serverId === 'string') patch.serverId = body.serverId.trim() || null;
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
          try { assertSshHost(body.host.trim()); } catch (error) { send(res, 400, { error: error.message }); return; }
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
      if (launcher.status(home.homeId)) {
        const current = home.endpoints?.find((e) => e.id === home.activeEndpointId);
        // 「正在使用的端点」只有两种动法会真的打断它：改动**当前**端点本身，或新增端点后要切过去。
        // 原先的判定是「没有 current 且提交了端点就拒绝」—— 而「没有 current」正是**拉起模式**
        // （实例由 hwb 自己启动、还没配置任何连接端点）的常态：用户想在设置里补一个端点，
        // 每次都被 409 挡住，而提示还建议「添加其他端点并切换后再修改」——切换 UI 需要 ≥2 个端点，
        // 所以那句建议在这条路径上**无法执行**（实测：同一请求先断开就 200）。
        // 现在：新增**与当前无关**的端点不再算「改动当前端点」（id 不同即无关；没有 current 时
        // 提交的都是新增），只有真的修改/删除当前端点才拒绝。
        const activeIncoming = current ? patch.endpoints?.find((e) => e.id === current.id) : null;
        const removedActive = Boolean(current) && Array.isArray(patch.endpoints) && !activeIncoming;
        const changedEndpoint = Boolean(patch.endpoints) && (removedActive
          || (activeIncoming && JSON.stringify(activeIncoming) !== JSON.stringify(current)));
        const changesConnection = ['host', 'remotePort', 'localPort', 'accessPort', 'homePath', 'remoteHome', 'remoteCmd', 'remoteLog', 'token'].some((key) => patch[key] !== undefined && patch[key] !== home[key]);
        if (changedEndpoint || changesConnection) {
          send(res, 409, { error: current
            ? '当前连接端点正在使用；可先「断开」，或添加其他端点并在卡片上切换后再修改它'
            : '当前连接正在使用这份配置；请先「断开」再修改' });
          return;
        }
      }
      const updated = store.updateHomeConfig(home.homeId, patch);
      dropUsageMemo();   // 别名决定「按实例」维度里的显示名，改名后不该还挂着旧名字
      send(res, 200, { home: { ...publicHome(updated), runtime: monitor.get(home.homeId) } });
      return;
    }
    if (req.method === 'DELETE' && delHome) {
      const homeId = delHome[1];
      const home = store.getHome(homeId);
      if (!home) {
        send(res, 404, { error: `unknown homeId ${homeId}` });
        return;
      }
      const key = instanceKey(home);
      if (connecting.has(key)) { send(res, 409, { error: '该实例正在连接或切换' }); return; }
      connecting.add(key);
      try {
        // 移除前先撤销接入与后台恢复，避免删除后旧连接重新出现。
        // release=true：实例即将从索引里消失，hwb 自己拉起的本机 dsh web 必须一并回收，
        // 否则它会一直占着端口与 DSH_HOME，且再也无法从 UI/API 触达。
        await launcher.disconnect(home, { release: true });
        store.removeHome(homeId);
        dropUsageMemo();   // 否则「按实例」图里还会留着刚移除的实例（见 dropUsageMemo 的注释）
        hub.broadcast('index:updated', { homeId, removed: true });
        send(res, 200, { ok: true, homeId });
      } finally { connecting.delete(key); }
      return;
    }
    if (req.method === 'POST' && pathname === '/api/homes/order') {
      const body = await readJsonBodyOr400(req, res);
      if (body === null) return;
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
          homeIds: store.listHomes().filter((h) => monitor.get(h.homeId).runtime === 'running').map((h) => h.homeId),
          days: numParam(searchParams.get('days'), 7, 1, 3650),
          limit: numParam(searchParams.get('limit'), 20, 1, 200),
        }),
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/sessions/recent') {
      send(res, 200, {
        sessions: store.recentSessions({
          homeIds: store.listHomes().filter((h) => monitor.get(h.homeId).runtime === 'running').map((h) => h.homeId),
          homeId: searchParams.get('homeId') || null,
          limit: numParam(searchParams.get('limit'), 50, 1, 500),
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
      const days = numParam(searchParams.get('days'), 30, 1, 365);
      // hours 支持到 30 天（24 * 30 = 720），对应「过去 30 天」统计周期。
      const hours = numParam(searchParams.get('hours'), 24, 1, 24 * 30);
      send(res, 200, usagePayload(days, hours));
      return;
    }
    if (req.method === 'GET' && pathname === '/api/logs') {
      // 日志区域：返回环缓冲中（可按最低级别过滤）的最近日志。
      const level = searchParams.get('level') || undefined;
      const limit = numParam(searchParams.get('limit'), 200, 1, 1000);
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
      const key = instanceKey(home);
      const sibling = store.listHomes().find((h) => h.homeId !== home.homeId && instanceKey(h) === key && launcher.status(h.homeId));
      if (sibling || connecting.has(key)) {
        send(res, 409, { error: sibling ? `同一实例已通过 ${sibling.host} 连接，请先断开该通道再切换` : '该实例正在连接，请稍候' });
        return;
      }
      connecting.add(key);
      try {
        const inst = await launcher.open(home);
        await monitor.refresh(home.homeId);
        if (monitor.get(home.homeId).runtime !== 'running') throw new Error('连接不可达，请断开后重试');
        // 连接成功后立即索引一次（此时 runtime=running，liveStatus 实时通道可用），
        // 新会话/状态马上进入工作台，不用等下一个 60s tick。
        reindexInBackground(home.homeId);
        send(res, 200, inst);
      } catch (e) {
        send(res, 502, { error: e.message });
      } finally {
        connecting.delete(key);
      }
      return;
    }

    const switchHome = pathname.match(/^\/api\/homes\/([0-9a-f]{16})\/switch$/);
    if (req.method === 'POST' && switchHome) {
      const home = store.getHome(switchHome[1]);
      if (!home) { send(res, 404, { error: '实例不存在' }); return; }
      const body = await readJsonBodyOr400(req, res);
      if (body === null) return;
      const endpoint = home.endpoints?.find((e) => e.id === body.endpointId);
      if (!endpoint) { send(res, 400, { error: '未知连接端点' }); return; }
      const key = instanceKey(home);
      if (connecting.has(key)) { send(res, 409, { error: '该实例正在连接或切换，请稍候' }); return; }
      connecting.add(key);
      try {
        const patch = endpointPatch(home, endpoint);
        if (endpoint.id !== home.activeEndpointId || !launcher.status(home.homeId)) {
          await launcher.switchEndpoint(home, { ...home, ...patch });
          store.updateHomeConfig(home.homeId, patch);
        }
        await monitor.refresh(home.homeId);
        reindexInBackground(home.homeId);
        hub.broadcast('instance:status', { homeId: home.homeId });
        send(res, 200, { homeId: home.homeId, activeEndpointId: endpoint.id });
      } catch (error) { send(res, 502, { error: error.message }); }
      finally { connecting.delete(key); }
      return;
    }

    const disconnectHome = pathname.match(/^\/api\/homes\/([0-9a-f]{16})\/disconnect$/);
    if (req.method === 'POST' && disconnectHome) {
      const home = store.getHome(disconnectHome[1]);
      if (!home) { send(res, 404, { error: '实例不存在' }); return; }
      if (connecting.has(instanceKey(home))) { send(res, 409, { error: '该实例正在连接，请稍候' }); return; }
      const key = instanceKey(home);
      connecting.add(key);
      try {
        await launcher.disconnect(home);
        await monitor.refresh(home.homeId);
        send(res, 200, { ok: true });
      } finally { connecting.delete(key); }
      return;
    }

    const stopHome = pathname.match(/^\/api\/homes\/([0-9a-f]{16})\/stop$/);
    if (req.method === 'POST' && stopHome) {
      const home = store.getHome(stopHome[1]);
      if (!home) {
        send(res, 404, { error: `unknown homeId ${stopHome[1]}` });
        return;
      }
      if (connecting.has(instanceKey(home)) || store.listHomes().some((h) => h.homeId !== home.homeId && instanceKey(h) === instanceKey(home) && launcher.status(h.homeId))) {
        send(res, 409, { error: '请使用当前已连接通道操作该实例' }); return;
      }
      const key = instanceKey(home);
      connecting.add(key);
      try {
        const stopped = await launcher.stop(home);
        await monitor.refresh(home.homeId);
        send(res, 200, { ok: true, stopped });
      } finally { connecting.delete(key); }
      return;
    }

    const restartHome = pathname.match(/^\/api\/homes\/([0-9a-f]{16})\/restart$/);
    if (req.method === 'POST' && restartHome) {
      const home = store.getHome(restartHome[1]);
      if (!home) {
        send(res, 404, { error: `unknown homeId ${restartHome[1]}` });
        return;
      }
      const key = instanceKey(home);
      const sibling = store.listHomes().find((h) => h.homeId !== home.homeId && instanceKey(h) === key && launcher.status(h.homeId));
      if (sibling || connecting.has(key)) {
        send(res, 409, { error: '同一实例已有其他通道连接或正在连接' });
        return;
      }
      connecting.add(key);
      try {
        const inst = await launcher.restart(home);
        await monitor.refresh(home.homeId);
        reindexInBackground(home.homeId); // 同 open：重启后立即索引，实时状态即刻入库
        send(res, 200, inst);
      } catch (e) {
        send(res, 502, { error: e.message });
      } finally {
        connecting.delete(key);
      }
      return;
    }

    send(res, 404, { error: `not found: ${req.method} ${pathname}` });
  };
}
