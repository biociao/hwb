// 服务器身份与 SSH 通道分离。未设置身份时保守地保留独立实例。
export function instanceKey(home) {
  if (home.endpoints?.length) return home.homeId;
  if (home.hostType !== 'remote' || !home.serverId) return home.homeId;
  const remoteHome = (home.remoteHome || '~/.dsh').replace(/\/+$/, '');
  // 相对 home 属于 SSH 登录用户；不同账号的 ~/.dsh 不能合并。
  const user = remoteHome.startsWith('/') ? '' : (home.host?.includes('@') ? home.host.slice(0, home.host.lastIndexOf('@')) : '');
  return JSON.stringify([home.serverId, user, remoteHome, Number(home.remotePort)]);
}

export function connectedHomes(homes) {
  const seen = new Set();
  return homes.filter((home) => {
    if (home.runtime?.runtime !== 'running') return false;
    const key = instanceKey(home);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 探测超时不等于连接已关闭。仍有入口 URL 的实例保留标签页和 iframe，
// 但不进入 connectedHomes 的项目 / 会话 / 用量统计。
export function tabHomes(homes) {
  const runningKeys = new Set(connectedHomes(homes).map(instanceKey));
  const seen = new Set();
  return homes.filter((home) => {
    const key = instanceKey(home);
    const runtime = home.runtime;
    const retained = runtime?.runtime === 'unreachable' && runtime.url && !runningKeys.has(key);
    if (runtime?.runtime !== 'running' && !retained) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
