import { readHome } from '../lib/read-home.js';
import { normalize } from '../lib/normalize.js';
import { readHomeRemote } from './remote-reader.js';

export function indexHome(store, homePath) {
  const snapshot = readHome(homePath);
  const rows = normalize(snapshot);
  store.upsertRows(rows);
  return { snapshot, rows };
}

// 远程实例只读索引（§4.6）：经 SSH cat 元数据 → buildSnapshot → normalize → 入库。
export async function indexRemoteHome(store, home, exec) {
  const snapshot = await readHomeRemote(home, exec);
  const rows = normalize(snapshot);
  store.upsertRows(rows);
  return { snapshot, rows };
}
