/**
 * Self-consistency of the two documents that make up the deliverable.
 *
 * Both checks are the kind of thing that rots silently: a §reference to a
 * renumbered section, or a `scripts/...` path in a command that no longer exists,
 * reads perfectly and fails only when someone follows it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DOCS = ['docs/dgx21-lowbandwidth-channel.md', 'scripts/README-dsh21.md'];

const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

test('every section reference resolves to a real heading', () => {
  for (const rel of DOCS) {
    const doc = read(rel);
    const headings = new Set();
    for (const line of doc.split('\n')) {
      const m = /^#{2,4}\s+(\d+(?:\.\d+)?)[.\s]/.exec(line);
      if (m) headings.add(m[1]);
    }
    const refs = [...new Set([...doc.matchAll(/§\s*(\d+(?:\.\d+)?)/g)].map((m) => m[1]))];
    const broken = refs.filter((r) => !headings.has(r));
    assert.deepEqual(broken, [], `${rel}: dangling section refs ${broken.join(', ')}`);
  }
});

test('every referenced repo path exists', () => {
  const broken = [];
  for (const rel of DOCS) {
    const doc = read(rel);
    const base = path.dirname(rel);
    for (const link of [...doc.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1])) {
      if (/^https?:/.test(link)) continue;
      const target = path.join(base, link);
      if (!existsSync(path.join(root, target))) broken.push(`${rel} -> ${link}`);
    }
    for (const p of [...doc.matchAll(/`((?:scripts|tests|src)\/[A-Za-z0-9_./-]+)`/g)].map((m) => m[1])) {
      if (!existsSync(path.join(root, p))) broken.push(`${rel} -> ${p}`);
    }
  }
  assert.deepEqual(broken, [], `documented paths that do not exist: ${broken.join(', ')}`);
});

test('the main doc keeps its reproduction index', () => {
  // If this section disappears, every number in the document stops being
  // independently checkable and the "reproducible" claim quietly fails.
  const doc = read('docs/dgx21-lowbandwidth-channel.md');
  assert.match(doc, /## 8\. 怎么复现本文的每个数字/);
  assert.match(doc, /node scripts\/dsh21\.mjs --measure/);
  assert.match(doc, /nodownload-check/);
});
