import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeIdOf } from '../src/lib/read-home.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-home');

const ms = (minAgo) => Date.now() - minAgo * 60_000;

// Mirrors the real ~/.dsh shapes: unit envelope + tables maps.
const workspaceJson = {
  unit: { name: 'workspace', version: 2 },
  global: {
    initialized: true,
    workspaceIds: ['ws-alpha', 'ws-beta', 'ws-gamma'],
    archivedSessionIds: [],
  },
  tables: {
    workspaces: {
      'ws-alpha': {
        title: 'hwb',
        path: '/Users/dev/repo/hwb',
        sessionIds: ['sess-001', 'sess-002'],
        createdAt: ms(60 * 24 * 30),
        updatedAt: ms(95),
      },
      'ws-beta': {
        title: 'quota-axi',
        path: '/Users/dev/repo/quota-axi',
        sessionIds: ['sess-003'],
        createdAt: ms(60 * 24 * 20),
        updatedAt: ms(7),
      },
      'ws-gamma': {
        title: 'cc-switch',
        path: '/Users/dev/repo/cc-switch',
        sessionIds: ['sess-004', 'sess-005'],
        createdAt: ms(60 * 24 * 15),
        updatedAt: ms(60 * 24 * 5),
      },
      'ws-old': {
        title: 'Remote_DSH_Center',
        path: '/Users/dev/repo/Remote_DSH_Center',
        sessionIds: [],
        createdAt: ms(60 * 24 * 90),
        updatedAt: ms(60 * 24 * 60),
      },
    },
  },
};

const projRow = (val) => ({ ver: 1, seq: 1, val });
const sess = ({ cwd, title, totals, pressure, lastPromptAt, createdAt }) => ({
  identity: { createdAt: createdAt ?? lastPromptAt, cwd },
  rows: {
    title: projRow(title),
    tokenUsage: projRow({ totals: totals, last: null }),
    ...(pressure ? { contextPressure: projRow(pressure) } : {}),
    sessionListMetadata: projRow({ blank: false, lastPromptAt }),
  },
});

const sessionProjcacheJson = {
  unit: { name: 'session_projcache', version: 3 },
  global: null,
  tables: {
    sessions: {
      'sess-001': sess({
        cwd: '/Users/dev/repo/hwb',
        title: '构建第一个 demo',
        totals: { uncachedInputTokens: 12400, outputTokens: 3200, cacheReadTokens: 88100, cacheWriteTokens: 5400 },
        pressure: { surfaceTokens: 900, pressureTokens: 45200, contextWindow: 128000 },
        lastPromptAt: ms(12),
      }),
      'sess-002': sess({
        cwd: '/Users/dev/repo/hwb',
        title: '阅读架构文档',
        totals: { uncachedInputTokens: 8100, outputTokens: 1950, cacheReadTokens: 40200, cacheWriteTokens: 2100 },
        pressure: { surfaceTokens: 700, pressureTokens: 18800, contextWindow: 128000 },
        lastPromptAt: ms(95),
      }),
      'sess-003': sess({
        cwd: '/Users/dev/repo/quota-axi',
        title: '额度适配器框架',
        totals: { uncachedInputTokens: 230000, outputTokens: 41200, cacheReadTokens: 610000, cacheWriteTokens: 18800 },
        pressure: { surfaceTokens: 1200, pressureTokens: 121000, contextWindow: 160000 },
        lastPromptAt: ms(7),
      }),
      'sess-004': sess({
        cwd: '/Users/dev/repo/cc-switch',
        title: '',
        totals: { uncachedInputTokens: 4300, outputTokens: 900, cacheReadTokens: 15600, cacheWriteTokens: 700 },
        lastPromptAt: ms(60 * 26),
      }),
      'sess-005': sess({
        cwd: '/Users/dev/repo/cc-switch',
        title: '多 provider 额度查询',
        totals: { uncachedInputTokens: 96400, outputTokens: 22100, cacheReadTokens: 310000, cacheWriteTokens: 9100 },
        pressure: { surfaceTokens: 1500, pressureTokens: 96000, contextWindow: 128000 },
        lastPromptAt: ms(60 * 24 * 5),
      }),
    },
  },
};

const modelTierJson = {
  schema: 2,
  enabled: true,
  activeId: 'scheme-mock',
  schemes: [
    {
      id: 'scheme-mock',
      name: 'mock',
      tiers: {
        strong: { provider: 'kimi', model: 'kimi-k2' },
        default: { provider: 'deepseek', model: 'deepseek-chat' },
        light: { provider: 'zai', model: 'glm-4.5-air' },
      },
    },
  ],
};

const credentialsYaml = `# dsh credentials — mock data, keys are fake
version: 1
refs:
  DEEPSEEK_API_KEY: sk-mock-deepseek-0000000000000000
  ZAI_API_KEY: mock-zai-key-0000000000000000
  KIMI_CODE_API_KEY: sk-mock-kimi-0000000000000000
  MINIMAX_CN_API_KEY: sk-mock-minimax-0000000000000000
`;

mkdirSync(path.join(root, 'storages'), { recursive: true });
writeFileSync(path.join(root, 'storages', 'workspace.json'), JSON.stringify(workspaceJson, null, 2));
writeFileSync(path.join(root, 'storages', 'session_projcache.json'), JSON.stringify(sessionProjcacheJson, null, 2));
writeFileSync(path.join(root, 'model-tier.json'), JSON.stringify(modelTierJson, null, 2));
writeFileSync(path.join(root, '.credentials.yaml'), credentialsYaml);

console.log(`mock home written to ${root}`);
console.log(`homeId: ${homeIdOf(root)}`);
