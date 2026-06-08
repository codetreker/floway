import { Hono } from 'hono';
import { test } from 'vitest';

import { exportData, importData } from './routes.ts';
import { DEFAULT_SEARCH_CONFIG } from '../../data-plane/tools/web-search/search-config.ts';
import { zValidator } from '../../middleware/zod-validator.ts';
import { initRepo } from '../../repo/index.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import type { ApiKey, PerformanceTelemetryRecord, SearchUsageRecord, StoredResponsesItem, UsageRecord } from '../../repo/types.ts';
import { exportQuery, importBody } from '../schemas.ts';
import { upstreamRecordToFullJson } from '../upstreams/serialize.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

const KEY_A: ApiKey = {
  id: 'key-a',
  name: 'Alice',
  key: 'raw-a',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: '2026-01-02T00:00:00.000Z',
  upstreamIds: null,
};

const KEY_B: ApiKey = {
  id: 'key-b',
  name: 'Bob',
  key: 'raw-b',
  createdAt: '2026-02-01T00:00:00.000Z',
  upstreamIds: null,
};

const CUSTOM_UPSTREAM: UpstreamRecord = {
  id: 'up_custom_a',
  provider: 'custom',
  name: 'Custom A',
  enabled: true,
  sortOrder: 10,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  flagOverrides: { 'messages-web-search-shim': true },
  disabledPublicModelIds: [],
  config: {
    baseUrl: 'https://custom.example.com',
    bearerToken: 'sk-custom',
    endpoints: { chatCompletions: {}, responses: {} },
    modelsFetch: { enabled: true, endpoint: '/models' },
  },
  state: null,
};

const COPILOT_UPSTREAM: UpstreamRecord = {
  id: 'up_copilot_a',
  provider: 'copilot',
  name: 'GitHub Copilot (alice)',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  config: {
    githubToken: 'ghu-alice',
    accountType: 'individual',
    user: {
      id: 100,
      login: 'alice',
      name: 'Alice',
      avatar_url: 'https://example.com/a.png',
    },
  },
  state: null,
};

const AZURE_UPSTREAM: UpstreamRecord = {
  id: 'up_azure_a',
  provider: 'azure',
  name: 'Azure A',
  enabled: true,
  sortOrder: 20,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  flagOverrides: {},
  disabledPublicModelIds: ['gpt-public'],
  config: {
    endpoint: 'https://example.openai.azure.com',
    apiKey: 'az-key',
    models: [
      {
        upstreamModelId: 'gpt-prod',
        publicModelId: 'gpt-public',
        kind: 'chat',
        endpoints: { chatCompletions: {}, responses: {}, embeddings: {} },
      },
      {
        upstreamModelId: 'deepseek-prod',
        kind: 'chat',
        endpoints: { chatCompletions: {} },
      },
    ],
  },
  state: null,
};

const CODEX_UPSTREAM: UpstreamRecord = {
  id: 'up_codex_a',
  provider: 'codex',
  name: 'ChatGPT Codex (alice)',
  enabled: true,
  sortOrder: 30,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  config: {
    accounts: [{
      email: 'alice@example.com',
      chatgptAccountId: 'acc_alice',
      chatgptUserId: 'usr_alice',
      planType: 'plus',
    }],
  },
  state: {
    accounts: [{
      chatgptAccountId: 'acc_alice',
      refresh_token: 'rt_alice_v3',
      state: 'active',
      state_updated_at: '2026-01-01T00:00:00.000Z',
    }],
  },
};

const USAGE_1: UsageRecord = {
  keyId: 'key-a',
  model: 'claude-opus-4-7',
  upstream: 'up_copilot_a',
  modelKey: 'claude-opus-4.7',
  hour: '2026-01-01T10',
  requests: 5,
  tokens: { input: 1000, output: 500, input_cache_read: 120, input_cache_write: 80 },
  cost: null,
};

const USAGE_2: UsageRecord = {
  keyId: 'key-b',
  model: 'gpt-public',
  upstream: 'up_azure_a',
  modelKey: 'gpt-prod',
  hour: '2026-01-01T11',
  requests: 3,
  tokens: { input: 2000, output: 800, input_cache_read: 200, input_cache_write: 50 },
  cost: null,
};

const SEARCH_USAGE_1: SearchUsageRecord = {
  provider: 'tavily',
  keyId: 'key-a',
  action: 'search',
  hour: '2026-01-01T10',
  requests: 2,
};

const SEARCH_USAGE_2: SearchUsageRecord = {
  provider: 'microsoft-grounding',
  keyId: 'key-b',
  action: 'fetch_page',
  hour: '2026-01-01T11',
  requests: 4,
};

const STORED_RESPONSES_ITEM: StoredResponsesItem = {
  id: 'msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA',
  apiKeyId: 'key-a',
  upstreamId: null,
  upstreamItemId: null,
  itemType: 'message',
  origin: 'synthetic',
  contentHash: null,
  encryptedContentHash: null,
  payload: { item: { type: 'message', id: 'msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA', role: 'assistant', content: [] } },
  createdAt: 1_000,
  refreshedAt: 1_000,
};

const PERFORMANCE_1: PerformanceTelemetryRecord = {
  hour: '2026-01-01T10',
  metricScope: 'request_total',
  keyId: 'key-a',
  model: 'claude-opus-4-7',
  upstream: 'up_copilot_a',
  modelKey: 'claude-opus-4.7',
  sourceApi: 'messages',
  targetApi: 'responses',
  stream: true,
  runtimeLocation: 'SJC',
  requests: 5,
  errors: 1,
  totalMsSum: 1250,
  buckets: [{ lowerMs: 100, upperMs: 142, count: 5 }],
};

const PERFORMANCE_2: PerformanceTelemetryRecord = {
  hour: '2026-01-01T11',
  metricScope: 'upstream_success',
  keyId: 'key-b',
  model: 'gpt-public',
  upstream: 'up_azure_a',
  modelKey: 'gpt-prod',
  sourceApi: 'responses',
  targetApi: 'chat-completions',
  stream: false,
  runtimeLocation: 'unknown',
  requests: 3,
  errors: 0,
  totalMsSum: 900,
  buckets: [{ lowerMs: 200, upperMs: 284, count: 3 }],
};

const setup = () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const app = new Hono();
  app.get('/export', zValidator('query', exportQuery), exportData);
  app.post('/import', zValidator('json', importBody), importData);
  return { repo, app };
};

const doExport = async (app: Hono, includePerformance = false) => {
  const resp = await app.request(includePerformance ? '/export?include_performance=1' : '/export');
  assertEquals(resp.status, 200);
  return (await resp.json()) as Record<string, any>;
};

const doImport = async (app: Hono, mode: string, data: unknown, version: unknown = 3) => {
  const resp = await app.request('/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, version, data }),
  });
  return { status: resp.status, body: (await resp.json()) as Record<string, any> };
};

const latestImportData = (overrides: Record<string, unknown> = {}) => ({
  apiKeys: [],
  upstreams: [],
  usage: [],
  searchUsage: [],
  performanceIncluded: false,
  searchConfig: DEFAULT_SEARCH_CONFIG,
  ...overrides,
});

test('export emits latest v2 structure with upstreams only', async () => {
  const { app } = setup();

  const result = await doExport(app);

  assertEquals(result.version, 3);
  assertEquals(typeof result.exportedAt, 'string');
  assertEquals(result.data.apiKeys, []);
  assertEquals(result.data.upstreams, []);
  assertEquals(result.data.usage, []);
  assertEquals(result.data.searchUsage, []);
  assertEquals(result.data.performanceIncluded, false);
  assertEquals(hasOwn(result.data, 'performance'), false);
  assertEquals(result.data.searchConfig, DEFAULT_SEARCH_CONFIG);
  assertEquals(hasOwn(result.data, 'githubAccounts'), false);
  assertEquals(hasOwn(result.data, 'upstreamConfigs'), false);
});

test('export includes full upstream configs and omits performance by default', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(COPILOT_UPSTREAM);
  await repo.upstreams.save(CUSTOM_UPSTREAM);
  await repo.upstreams.save(AZURE_UPSTREAM);
  await repo.usage.set(USAGE_1);
  await repo.searchUsage.set(SEARCH_USAGE_1);
  await repo.performance.set(PERFORMANCE_1);
  await repo.searchConfig.save({ provider: 'tavily', tavily: { apiKey: 'tvly-test' }, microsoftGrounding: { apiKey: 'ms-test' } });

  const result = await doExport(app);

  assertEquals(result.data.apiKeys, [KEY_A]);
  assertEquals(result.data.upstreams.map((upstream: any) => upstream.id), ['up_copilot_a', 'up_custom_a', 'up_azure_a']);
  assertEquals(result.data.upstreams.find((upstream: any) => upstream.id === 'up_custom_a').config.bearerToken, 'sk-custom');
  assertEquals(result.data.upstreams.find((upstream: any) => upstream.id === 'up_copilot_a').config.githubToken, 'ghu-alice');
  assertEquals(result.data.upstreams.find((upstream: any) => upstream.id === 'up_azure_a').config.apiKey, 'az-key');
  assertEquals(result.data.usage, [USAGE_1]);
  assertEquals(result.data.searchUsage, [SEARCH_USAGE_1]);
  assertEquals(result.data.performanceIncluded, false);
  assertEquals(hasOwn(result.data, 'performance'), false);
  assertEquals(result.data.searchConfig.provider, 'tavily');
});

test('export includes performance only when requested', async () => {
  const { app, repo } = setup();
  await repo.performance.set(PERFORMANCE_1);
  await repo.performance.set(PERFORMANCE_2);

  const defaultExport = await doExport(app);
  const fullExport = await doExport(app, true);

  assertEquals(defaultExport.data.performanceIncluded, false);
  assertEquals(hasOwn(defaultExport.data, 'performance'), false);
  assertEquals(fullExport.data.performanceIncluded, true);
  assertEquals(fullExport.data.performance, [PERFORMANCE_1, PERFORMANCE_2]);
});

test('import rejects missing or mismatched version before deleting data', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(CUSTOM_UPSTREAM);

  const oldVersion = await doImport(app, 'replace', { apiKeys: [] }, 1);
  const missingVersionResponse = await app.request('/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'replace', data: { apiKeys: [] } }),
  });
  const missingVersion = { status: missingVersionResponse.status, body: (await missingVersionResponse.json()) as Record<string, any> };

  assertEquals(oldVersion.status, 400);
  assertEquals(oldVersion.body.error, 'version must be 3');
  assertEquals(missingVersion.status, 400);
  assertEquals(missingVersion.body.error, 'version must be 3');
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals((await repo.upstreams.list()).map(upstream => upstream.id), ['up_custom_a']);
});

test('import replace writes v2 upstreams and clears replaced collections', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(CUSTOM_UPSTREAM);
  await repo.usage.set(USAGE_1);
  await repo.searchUsage.set(SEARCH_USAGE_1);
  await repo.responsesItems.insertMany([STORED_RESPONSES_ITEM]);
  await repo.searchConfig.save({ provider: 'tavily', tavily: { apiKey: 'old' }, microsoftGrounding: { apiKey: '' } });

  const result = await doImport(app, 'replace', {
    apiKeys: [KEY_B],
    upstreams: [upstreamRecordToFullJson(AZURE_UPSTREAM)],
    usage: [USAGE_2],
    searchUsage: [SEARCH_USAGE_2],
    performanceIncluded: false,
    searchConfig: { provider: 'microsoft-grounding', tavily: { apiKey: '' }, microsoftGrounding: { apiKey: 'ms-new' } },
  });

  assertEquals(result.status, 200);
  assertEquals(result.body.imported, { apiKeys: 1, upstreams: 1, usage: 1, searchUsage: 1, performance: 0 });
  assertEquals(await repo.apiKeys.list(), [KEY_B]);
  assertEquals(await repo.upstreams.list(), [AZURE_UPSTREAM]);
  assertEquals(await repo.usage.listAll(), [USAGE_2]);
  assertEquals(await repo.searchUsage.listAll(), [SEARCH_USAGE_2]);
  assertEquals(await repo.responsesItems.lookupMany('key-a', [STORED_RESPONSES_ITEM.id]), []);
  assertEquals(await repo.searchConfig.get(), { provider: 'microsoft-grounding', tavily: { apiKey: '' }, microsoftGrounding: { apiKey: 'ms-new' } });
});

test('import merge upserts by repository key without clearing unrelated rows', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(CUSTOM_UPSTREAM);
  await repo.usage.set({ ...USAGE_1, requests: 10 });
  await repo.searchUsage.set({ ...SEARCH_USAGE_1, requests: 10 });

  const updatedCustom = { ...CUSTOM_UPSTREAM, name: 'Custom Updated', updatedAt: '2026-03-01T00:00:00.000Z' } satisfies UpstreamRecord;
  const result = await doImport(app, 'merge', latestImportData({
    apiKeys: [{ ...KEY_A, name: 'Alice Updated' }, KEY_B],
    upstreams: [upstreamRecordToFullJson(updatedCustom), upstreamRecordToFullJson(COPILOT_UPSTREAM)],
    usage: [USAGE_1],
    searchUsage: [SEARCH_USAGE_1],
  }));

  assertEquals(result.status, 200);
  assertEquals((await repo.apiKeys.list()).map(key => key.name), ['Alice Updated', 'Bob']);
  assertEquals((await repo.upstreams.list()).map(upstream => [upstream.id, upstream.name]), [
    ['up_copilot_a', 'GitHub Copilot (alice)'],
    ['up_custom_a', 'Custom Updated'],
  ]);
  assertEquals(await repo.usage.listAll(), [USAGE_1]);
  assertEquals(await repo.searchUsage.listAll(), [SEARCH_USAGE_1]);
});

test('import replace handles performance inclusion explicitly', async () => {
  const { app, repo } = setup();
  await repo.performance.set(PERFORMANCE_1);

  const preserve = await doImport(app, 'replace', latestImportData());
  assertEquals(preserve.status, 200);
  assertEquals(await repo.performance.listAll(), [PERFORMANCE_1]);

  const replace = await doImport(app, 'replace', {
    apiKeys: [],
    upstreams: [],
    usage: [],
    searchUsage: [],
    performanceIncluded: true,
    performance: [PERFORMANCE_2],
    searchConfig: DEFAULT_SEARCH_CONFIG,
  });

  assertEquals(replace.status, 200);
  assertEquals(await repo.performance.listAll(), [PERFORMANCE_2]);
});

test('import rejects missing upstreams before clearing existing data', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(CUSTOM_UPSTREAM);
  await repo.usage.set(USAGE_1);

  const result = await doImport(app, 'replace', {
    apiKeys: [KEY_B],
    usage: [USAGE_2],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_SEARCH_CONFIG,
  });

  assertEquals(result.status, 400);
  assertEquals(result.body.error, 'invalid upstreams: upstreams must be an array');
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals(await repo.upstreams.list(), [CUSTOM_UPSTREAM]);
  assertEquals(await repo.usage.listAll(), [USAGE_1]);
});

test('codex upstreams export and import round-trip with state intact', async () => {
  const { app, repo } = setup();
  await repo.upstreams.save(CODEX_UPSTREAM);
  await repo.searchConfig.save(DEFAULT_SEARCH_CONFIG);

  const result = await doExport(app);
  const exportedCodex = result.data.upstreams.find((upstream: any) => upstream.id === 'up_codex_a');
  assertEquals(exportedCodex.config, CODEX_UPSTREAM.config);
  assertEquals(exportedCodex.state, CODEX_UPSTREAM.state);

  const replaceResult = await doImport(app, 'replace', {
    apiKeys: [],
    upstreams: [exportedCodex],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_SEARCH_CONFIG,
  });
  assertEquals(replaceResult.status, 200);
  assertEquals(await repo.upstreams.list(), [CODEX_UPSTREAM]);
});

test('codex import rejects when state is missing', async () => {
  const { app } = setup();
  const { state: _dropped, ...stateless } = upstreamRecordToFullJson(CODEX_UPSTREAM);
  const result = await doImport(app, 'replace', {
    apiKeys: [],
    upstreams: [{ ...stateless, state: null }],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_SEARCH_CONFIG,
  });
  assertEquals(result.status, 400);
  assertEquals(result.body.error.includes('codex upstream import is missing state'), true);
});

test('codex import rejects unknown keys in state', async () => {
  const { app } = setup();
  const exported = upstreamRecordToFullJson(CODEX_UPSTREAM);
  const result = await doImport(app, 'replace', {
    apiKeys: [],
    upstreams: [{ ...exported, state: { ...(exported.state as object), smuggled: 'x' } }],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_SEARCH_CONFIG,
  });
  assertEquals(result.status, 400);
  assertEquals(result.body.error.includes('unexpected key'), true);
});

test('import rejects invalid records before clearing existing data', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(CUSTOM_UPSTREAM);
  await repo.searchUsage.set(SEARCH_USAGE_1);

  const badApiKeys = await doImport(app, 'replace', {
    apiKeys: [{ ...KEY_B, key: '' }],
    upstreams: [],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_SEARCH_CONFIG,
  });
  const badUsage = await doImport(app, 'replace', {
    apiKeys: [],
    upstreams: [],
    usage: [{ ...USAGE_2, requests: -1 }],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_SEARCH_CONFIG,
  });
  const badUpstream = await doImport(app, 'replace', {
    apiKeys: [],
    upstreams: [{ ...upstreamRecordToFullJson(CUSTOM_UPSTREAM), config: { baseUrl: 'https://custom.example.com', bearerToken: 'sk', endpoints: { bogus: {} } } }],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_SEARCH_CONFIG,
  });
  const badFixes = await doImport(app, 'replace', {
    apiKeys: [],
    upstreams: [{ ...upstreamRecordToFullJson(CUSTOM_UPSTREAM), flag_overrides: { 'made-up-fix': true } }],
    usage: [],
    searchUsage: [],
    performanceIncluded: false,
    searchConfig: DEFAULT_SEARCH_CONFIG,
  });
  const badSearchUsage = await doImport(app, 'replace', {
    apiKeys: [],
    upstreams: [],
    usage: [],
    searchUsage: [{ provider: 'not-real', keyId: 'key-a', hour: '2026-01-01T10', requests: 1 }],
    performanceIncluded: false,
    searchConfig: DEFAULT_SEARCH_CONFIG,
  });

  assertEquals(badApiKeys.status, 400);
  assertEquals(badApiKeys.body.error, 'invalid apiKeys at index 0: key must be a non-empty string');
  assertEquals(badUsage.status, 400);
  assertEquals(badUsage.body.error, 'invalid usage at index 0: record has invalid usage fields');
  assertEquals(badUpstream.status, 400);
  assertEquals(String(badUpstream.body.error).includes('invalid upstreams at index 0'), true);
  assertEquals(badFixes.status, 400);
  assertEquals(badFixes.body.error, 'invalid upstreams at index 0: Unknown flag_overrides ids: made-up-fix');
  assertEquals(badSearchUsage.status, 400);
  assertEquals(badSearchUsage.body.error, 'invalid searchUsage at index 0: invalid provider');
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals(await repo.upstreams.list(), [CUSTOM_UPSTREAM]);
  assertEquals(await repo.searchUsage.listAll(), [SEARCH_USAGE_1]);
});

test('import rejects api key unique identity conflicts before mutating', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(CUSTOM_UPSTREAM);

  const duplicateRawKey = await doImport(app, 'replace', latestImportData({
    apiKeys: [KEY_B, { ...KEY_A, id: 'key-c', key: KEY_B.key }],
  }));
  const duplicateId = await doImport(app, 'replace', latestImportData({
    apiKeys: [KEY_B, { ...KEY_B, name: 'Duplicate Bob' }],
  }));
  const mergeExistingRawKeyConflict = await doImport(app, 'merge', latestImportData({
    apiKeys: [{ ...KEY_B, key: KEY_A.key }],
  }));

  assertEquals(duplicateRawKey.status, 400);
  assertEquals(duplicateRawKey.body.error, 'invalid apiKeys: duplicate apiKeys raw key used by key-b and key-c');
  assertEquals(duplicateId.status, 400);
  assertEquals(duplicateId.body.error, 'invalid apiKeys: duplicate apiKeys id key-b at indexes 0 and 1');
  assertEquals(mergeExistingRawKeyConflict.status, 400);
  assertEquals(mergeExistingRawKeyConflict.body.error, 'invalid apiKeys: apiKeys raw key for key-b conflicts with existing api key key-a');
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals(await repo.upstreams.list(), [CUSTOM_UPSTREAM]);
});

test('import rejects legacy provider-prefixed upstream identities before mutating', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(CUSTOM_UPSTREAM);

  const legacyUpstreamId = await doImport(app, 'replace', latestImportData({
    upstreams: [{ ...upstreamRecordToFullJson(CUSTOM_UPSTREAM), id: 'openai:up_custom_a' }],
  }));
  const legacyUsageUpstream = await doImport(app, 'replace', latestImportData({
    usage: [{ ...USAGE_1, upstream: 'copilot:1' }],
  }));
  const legacyPerformanceUpstream = await doImport(app, 'replace', latestImportData({
    performanceIncluded: true,
    performance: [{ ...PERFORMANCE_1, upstream: 'copilot:1' }],
  }));

  assertEquals(legacyUpstreamId.status, 400);
  assertEquals(legacyUpstreamId.body.error, 'invalid upstreams at index 0: id must use a raw upstream id, not a legacy provider-prefixed identity');
  assertEquals(legacyUsageUpstream.status, 400);
  assertEquals(legacyUsageUpstream.body.error, 'invalid usage at index 0: upstream must use a raw upstream id, not a legacy provider-prefixed identity');
  assertEquals(legacyPerformanceUpstream.status, 400);
  assertEquals(legacyPerformanceUpstream.body.error, 'invalid performance record at index 0');
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals(await repo.upstreams.list(), [CUSTOM_UPSTREAM]);
});

test('import rejects legacy enabled_fixes payloads before mutating', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(CUSTOM_UPSTREAM);

  const { flag_overrides: _flagOverrides, ...customWithoutFlagOverrides } = upstreamRecordToFullJson(CUSTOM_UPSTREAM);
  const legacyEnabledFixes = await doImport(app, 'replace', latestImportData({
    upstreams: [{ ...customWithoutFlagOverrides, enabled_fixes: ['messages-web-search-shim'] }],
  }));
  const legacyAlongsideNew = await doImport(app, 'replace', latestImportData({
    upstreams: [{ ...upstreamRecordToFullJson(CUSTOM_UPSTREAM), enabled_fixes: [] }],
  }));

  assertEquals(legacyEnabledFixes.status, 400);
  assertEquals(String(legacyEnabledFixes.body.error).includes("legacy 'enabled_fixes' field is no longer supported"), true);
  assertEquals(legacyAlongsideNew.status, 400);
  assertEquals(String(legacyAlongsideNew.body.error).includes("legacy 'enabled_fixes' field is no longer supported"), true);
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals(await repo.upstreams.list(), [CUSTOM_UPSTREAM]);
});

test('import rejects missing latest-v2 arrays before clearing existing data', async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);
  await repo.upstreams.save(CUSTOM_UPSTREAM);
  await repo.usage.set(USAGE_1);
  await repo.searchUsage.set(SEARCH_USAGE_1);

  const missingApiKeys = await doImport(app, 'replace', latestImportData({ apiKeys: undefined }));
  const missingUsage = await doImport(app, 'replace', latestImportData({ usage: undefined }));
  const missingSearchUsage = await doImport(app, 'replace', latestImportData({ searchUsage: undefined }));

  assertEquals(missingApiKeys.status, 400);
  assertEquals(missingApiKeys.body.error, 'invalid apiKeys: apiKeys must be an array');
  assertEquals(missingUsage.status, 400);
  assertEquals(missingUsage.body.error, 'invalid usage: usage must be an array');
  assertEquals(missingSearchUsage.status, 400);
  assertEquals(missingSearchUsage.body.error, 'invalid searchUsage: searchUsage must be an array');
  assertEquals(await repo.apiKeys.list(), [KEY_A]);
  assertEquals(await repo.upstreams.list(), [CUSTOM_UPSTREAM]);
  assertEquals(await repo.usage.listAll(), [USAGE_1]);
  assertEquals(await repo.searchUsage.listAll(), [SEARCH_USAGE_1]);
});

test('import validates mode and data before mutating', async () => {
  const { app } = setup();

  const invalidMode = await doImport(app, 'invalid', {}, 3);
  const missingData = await app.request('/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'replace', version: 3 }),
  });
  const missingUpstreams = await doImport(app, 'merge', {}, 3);
  const emptyMerge = await doImport(app, 'merge', latestImportData(), 3);

  assertEquals(invalidMode.status, 400);
  assertEquals(invalidMode.body.error, "mode must be 'merge' or 'replace'");
  assertEquals(missingData.status, 400);
  assertEquals(((await missingData.json()) as { error: string }).error, 'data is required');
  assertEquals(missingUpstreams.status, 400);
  assertEquals(missingUpstreams.body.error, 'invalid apiKeys: apiKeys must be an array');
  assertEquals(emptyMerge.status, 200);
  assertEquals(emptyMerge.body.imported, { apiKeys: 0, upstreams: 0, usage: 0, searchUsage: 0, performance: 0 });
});
