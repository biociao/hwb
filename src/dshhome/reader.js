import { readHome } from '../lib/read-home.js';
import { normalize } from '../lib/normalize.js';

export function indexHome(store, homePath) {
  const snapshot = readHome(homePath);
  const rows = normalize(snapshot);
  store.upsertRows(rows);
  return { snapshot, rows };
}
