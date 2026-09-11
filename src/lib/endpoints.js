import { randomUUID } from 'node:crypto';

export function normalizeEndpoints(value, hostType) {
  if (!Array.isArray(value) || value.length > 32 || (hostType === 'remote' && !value.length)) {
    throw new Error('远程实例需配置 1–32 个连接端点');
  }
  const ids = new Set(), addresses = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('连接端点格式错误');
    const id = entry.id || randomUUID();
    if (typeof id !== 'string' || id.length > 100 || ids.has(id)) throw new Error('连接端点 ID 重复或无效');
    ids.add(id);
    const host = hostType === 'remote' && typeof entry.host === 'string' ? entry.host.trim() : null;
    if (hostType === 'remote') assertSshHost(host);
    // 端口必须真的是端口，而不是「能被 Number() 变成合法数字的东西」：
    // Number(true) === 1、Number([22]) === 22、Number('0x50') === 80、Number('1e3') === 1000 ——
    // 这些都会被静默接受并落库，用户看到的是一个和他输入不一致的端口。
    const rawPort = entry.port;
    const port = typeof rawPort === 'number' ? rawPort
      : (typeof rawPort === 'string' && /^\d+$/.test(rawPort.trim()) ? Number(rawPort.trim()) : NaN);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('请填写有效的主机和端口（1–65535）');
    }
    const address = JSON.stringify([host, port]);
    if (addresses.has(address)) throw new Error('连接端点的主机和端口重复');
    addresses.add(address);
    return { id, label: String(entry.label || '').trim().slice(0, 100), host, port,
      token: typeof entry.token === 'string' ? entry.token.trim() || null : null };
  });
}

/**
 * SSH 目标主机名的校验，**只有这一处**。
 *
 * 必须挡住的：前导 `-` —— ssh 会把 `-oProxyCommand=…` 这样的参数当成**选项**而不是主机名，
 * 那等于本地命令执行（调用方都用了 `--` 或把 host 放在 destination 位置，所以目前还打不到，
 * 但这个约束一旦在某个新调用点失守就是 RCE）；以及空白（会被 ssh 拆成多个参数）。
 *
 * 之所以单独导出：写入 `homes.host` 有两条路径（端点列表与旧的单 host 字段），
 * 原先只有端点那条走了校验，旧字段一路存进库、要到 updateHomeConfig 才抛错 ——
 * 结果是「接口 500，但实例已经建好了」，用户只能手工删。
 */
export function assertSshHost(host) {
  // 长度上限：id/label 都有 100 的上限，host 原先没有 —— 一个 10000 字符的「主机名」会被照单收下。
  // （DNS 名上限 253、SSH 目标可能带 user@，255 足够宽松。）
  if (!host || typeof host !== 'string' || host.startsWith('-') || /\s/.test(host) || host.length > 255) {
    throw new Error('请填写有效的主机名（不能以 - 开头、不能含空白、长度 ≤ 255）');
  }
  return host;
}

export function endpointPatch(home, endpoint) {
  return { activeEndpointId: endpoint.id, token: endpoint.token,
    ...(home.hostType === 'remote' ? { host: endpoint.host, remotePort: endpoint.port } : { localPort: endpoint.port }) };
}

export function legacyEndpoint(home) {
  const port = home.hostType === 'remote' ? home.remotePort : home.localPort;
  return port ? { id: `endpoint-${home.homeId}`, label: home.host || `本机 :${port}`,
    host: home.hostType === 'remote' ? home.host : null, port, token: home.token || null } : null;
}
