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
    const port = Number(entry.port);
    if ((hostType === 'remote' && (!host || host.startsWith('-') || /\s/.test(host))) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('请填写有效的主机和端口（1–65535）');
    }
    const address = JSON.stringify([host, port]);
    if (addresses.has(address)) throw new Error('连接端点的主机和端口重复');
    addresses.add(address);
    return { id, label: String(entry.label || '').trim().slice(0, 100), host, port,
      token: typeof entry.token === 'string' ? entry.token.trim() || null : null };
  });
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
