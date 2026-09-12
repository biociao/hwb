import { DatabaseSync } from 'node:sqlite';
const CURRENT = '/Volumes/repo/ciao/github.com/hwb/src/dshhome/store.js';
const PREV = '/tmp/hwb-rev/prev/src/dshhome/store.js';
const db = '/tmp/hwb-rev/lock2.db';
// 先用当前版本建好并迁移完整
const { IndexStore: Cur } = await import(CURRENT);
const a = new Cur(db); a.registerHome({ homePath: '/mock/home', hostType: 'local' }); a.close();

// 加锁
const holder = new DatabaseSync(db);
holder.exec('BEGIN IMMEDIATE');
holder.exec("UPDATE homes SET status='x' WHERE 1=0");

for (const [label, mod] of [['PREV(410d222)', PREV], ['CURRENT(HEAD)', CURRENT]]) {
  const { IndexStore } = await import(mod);
  try { const s = new IndexStore(db); console.log(label, ': OPEN OK'); s.close(); }
  catch (e) { console.log(label, ': FAILED ->', e.message.slice(0, 80).replace(/\n/g, ' ')); }
}
holder.exec('ROLLBACK'); holder.close();
