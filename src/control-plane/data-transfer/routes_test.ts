import { test } from "vitest";
import { assertEquals } from "../../test-assert.ts";
import { Hono } from "hono";
import { DEFAULT_SEARCH_CONFIG } from "../../data-plane/tools/web-search/search-config.ts";
import { initRepo } from "../../repo/index.ts";
import { InMemoryRepo } from "../../repo/memory.ts";
import type {
  ApiKey,
  GitHubAccount,
  PerformanceTelemetryRecord,
  SearchUsageRecord,
  UsageRecord,
} from "../../repo/types.ts";
import { exportData, importData } from "./routes.ts";

const hasOwn = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

// ---- Fixtures ----

const KEY_A: ApiKey = {
  id: "key-aaa",
  name: "Alice",
  key: "raw-key-aaa",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: "2026-01-02T00:00:00.000Z",
};

const KEY_B: ApiKey = {
  id: "key-bbb",
  name: "Bob",
  key: "raw-key-bbb",
  createdAt: "2026-02-01T00:00:00.000Z",
};

const ACCOUNT_X: GitHubAccount = {
  token: "ghu_xxxx",
  accountType: "individual",
  user: {
    id: 100,
    login: "alice",
    name: "Alice",
    avatar_url: "https://example.com/a.png",
  },
};

const ACCOUNT_Y: GitHubAccount = {
  token: "ghu_yyyy",
  accountType: "enterprise",
  user: {
    id: 200,
    login: "bob",
    name: null,
    avatar_url: "https://example.com/b.png",
  },
};

const USAGE_1: UsageRecord = {
  keyId: "key-aaa",
  model: "claude-opus-4-6",
  upstream: "copilot:100",
  modelKey: "claude-opus-4.6",
  hour: "2026-01-01T10",
  requests: 5,
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 120,
  cacheCreationTokens: 80,
};

const USAGE_2: UsageRecord = {
  keyId: "key-bbb",
  model: "gpt-5.4",
  upstream: "openai:custom",
  modelKey: "gpt-5.4",
  hour: "2026-01-01T11",
  requests: 3,
  inputTokens: 2000,
  outputTokens: 800,
  cacheReadTokens: 200,
  cacheCreationTokens: 50,
};

const SEARCH_USAGE_1: SearchUsageRecord = {
  provider: "tavily",
  keyId: "key-aaa",
  hour: "2026-01-01T10",
  requests: 2,
};

const SEARCH_USAGE_2: SearchUsageRecord = {
  provider: "microsoft-grounding",
  keyId: "key-bbb",
  hour: "2026-01-01T11",
  requests: 4,
};

const PERFORMANCE_1: PerformanceTelemetryRecord = {
  hour: "2026-01-01T10",
  metricScope: "request_total",
  keyId: "key-aaa",
  model: "claude-opus-4-7",
  upstream: "copilot:100",
  modelKey: "claude-opus-4.7-xhigh",
  sourceApi: "messages",
  targetApi: "responses",
  stream: true,
  runtimeLocation: "SJC",
  requests: 5,
  errors: 1,
  totalMsSum: 1250,
  buckets: [{ lowerMs: 100, upperMs: 142, count: 5 }],
};

const PERFORMANCE_2: PerformanceTelemetryRecord = {
  hour: "2026-01-01T11",
  metricScope: "upstream_success",
  keyId: "key-bbb",
  model: "gpt-5.3-codex",
  upstream: "openai:custom",
  modelKey: "gpt-5.3-codex",
  sourceApi: "responses",
  targetApi: "chat-completions",
  stream: false,
  runtimeLocation: "unknown",
  requests: 3,
  errors: 0,
  totalMsSum: 900,
  buckets: [{ lowerMs: 200, upperMs: 284, count: 3 }],
};

const PERFORMANCE_GEMINI: PerformanceTelemetryRecord = {
  hour: "2026-01-01T12",
  metricScope: "request_total",
  keyId: "key-aaa",
  model: "claude-sonnet-4-5",
  upstream: "copilot:100",
  modelKey: "claude-sonnet-4.5",
  sourceApi: "gemini",
  targetApi: "messages",
  stream: true,
  runtimeLocation: "SJC",
  requests: 7,
  errors: 0,
  totalMsSum: 1400,
  buckets: [{ lowerMs: 100, upperMs: 142, count: 7 }],
};

// ---- Helpers ----

function setup() {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const app = new Hono();
  app.get("/export", exportData);
  app.post("/import", importData);
  return { repo, app };
}

async function doExport(app: Hono, includePerformance = false) {
  const resp = await app.request(
    includePerformance ? "/export?include_performance=1" : "/export",
  );
  assertEquals(resp.status, 200);
  return await resp.json();
}

async function doImport(app: Hono, mode: string, data: any) {
  const resp = await app.request("/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, data }),
  });
  return { status: resp.status, body: await resp.json() };
}

// ---- Tests: export structure ----

test("export — empty database returns correct structure", async () => {
  const { app } = setup();
  const result = await doExport(app);

  assertEquals(result.version, 1);
  assertEquals(typeof result.exportedAt, "string");
  assertEquals(Array.isArray(result.data.apiKeys), true);
  assertEquals(result.data.apiKeys.length, 0);
  assertEquals(Array.isArray(result.data.githubAccounts), true);
  assertEquals(result.data.githubAccounts.length, 0);
  assertEquals(Array.isArray(result.data.usage), true);
  assertEquals(result.data.usage.length, 0);
  assertEquals(Array.isArray(result.data.searchUsage), true);
  assertEquals(result.data.searchUsage.length, 0);
  assertEquals(result.data.performanceIncluded, false);
  assertEquals(hasOwn(result.data, "performance"), false);
  assertEquals(result.data.searchConfig, DEFAULT_SEARCH_CONFIG);
});

test("export — contains stored data without performance by default", async () => {
  const { app, repo } = setup();

  await repo.apiKeys.save(KEY_A);
  await repo.apiKeys.save(KEY_B);
  await repo.github.saveAccount(ACCOUNT_X.user.id, ACCOUNT_X);
  await repo.github.saveAccount(ACCOUNT_Y.user.id, ACCOUNT_Y);
  await repo.usage.set(USAGE_1);
  await repo.usage.set(USAGE_2);
  await repo.searchUsage.set(SEARCH_USAGE_1);
  await repo.searchUsage.set(SEARCH_USAGE_2);
  await repo.performance.set(PERFORMANCE_1);
  await repo.performance.set(PERFORMANCE_2);
  await repo.searchConfig.save({
    provider: "tavily",
    tavily: { apiKey: "tvly-test" },
    microsoftGrounding: { apiKey: "ms-test" },
  });

  const result = await doExport(app);

  assertEquals(result.data.apiKeys.length, 2);
  assertEquals(result.data.githubAccounts.length, 2);
  assertEquals(result.data.usage.length, 2);
  assertEquals(result.data.searchUsage.length, 2);
  assertEquals(result.data.performanceIncluded, false);
  assertEquals(hasOwn(result.data, "performance"), false);
  assertEquals(result.data.searchConfig.provider, "tavily");
});

test("export — includes performance only when requested", async () => {
  const { app, repo } = setup();

  await repo.performance.set(PERFORMANCE_1);
  await repo.performance.set(PERFORMANCE_2);

  const defaultExport = await doExport(app);
  const fullExport = await doExport(app, true);

  assertEquals(defaultExport.data.performanceIncluded, false);
  assertEquals(hasOwn(defaultExport.data, "performance"), false);
  assertEquals(fullExport.data.performanceIncluded, true);
  assertEquals(fullExport.data.performance.length, 2);
});

test("export — apiKeys contain all fields", async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_A);

  const result = await doExport(app);
  const key = result.data.apiKeys[0];

  assertEquals(key.id, KEY_A.id);
  assertEquals(key.name, KEY_A.name);
  assertEquals(key.key, KEY_A.key);
  assertEquals(key.createdAt, KEY_A.createdAt);
  assertEquals(key.lastUsedAt, KEY_A.lastUsedAt);
});

test("export — apiKey without lastUsedAt omits or nulls it", async () => {
  const { app, repo } = setup();
  await repo.apiKeys.save(KEY_B); // KEY_B has no lastUsedAt

  const result = await doExport(app);
  const key = result.data.apiKeys[0];

  assertEquals(key.id, KEY_B.id);
  // lastUsedAt should be absent or null/undefined
  assertEquals(key.lastUsedAt == null, true);
});

test("export — githubAccounts contain all fields", async () => {
  const { app, repo } = setup();
  await repo.github.saveAccount(ACCOUNT_X.user.id, ACCOUNT_X);

  const result = await doExport(app);
  const account = result.data.githubAccounts[0];

  assertEquals(account.token, ACCOUNT_X.token);
  assertEquals(account.accountType, ACCOUNT_X.accountType);
  assertEquals(account.user.id, ACCOUNT_X.user.id);
  assertEquals(account.user.login, ACCOUNT_X.user.login);
  assertEquals(account.user.name, ACCOUNT_X.user.name);
  assertEquals(account.user.avatar_url, ACCOUNT_X.user.avatar_url);
});

test("export — githubAccount with null name", async () => {
  const { app, repo } = setup();
  await repo.github.saveAccount(ACCOUNT_Y.user.id, ACCOUNT_Y);

  const result = await doExport(app);
  assertEquals(result.data.githubAccounts[0].user.name, null);
});

test("export — usage records contain all fields", async () => {
  const { app, repo } = setup();
  await repo.usage.set(USAGE_1);

  const result = await doExport(app);
  const u = result.data.usage[0];

  assertEquals(u.keyId, USAGE_1.keyId);
  assertEquals(u.model, USAGE_1.model);
  assertEquals(u.hour, USAGE_1.hour);
  assertEquals(u.requests, USAGE_1.requests);
  assertEquals(u.inputTokens, USAGE_1.inputTokens);
  assertEquals(u.outputTokens, USAGE_1.outputTokens);
  assertEquals(u.cacheReadTokens, USAGE_1.cacheReadTokens);
  assertEquals(u.cacheCreationTokens, USAGE_1.cacheCreationTokens);
});

test("export — searchUsage records contain all fields", async () => {
  const { app, repo } = setup();
  await repo.searchUsage.set(SEARCH_USAGE_1);

  const result = await doExport(app);
  const u = result.data.searchUsage[0];

  assertEquals(u.provider, SEARCH_USAGE_1.provider);
  assertEquals(u.keyId, SEARCH_USAGE_1.keyId);
  assertEquals(u.hour, SEARCH_USAGE_1.hour);
  assertEquals(u.requests, SEARCH_USAGE_1.requests);
});

test("export — performance records contain raw dimensions and buckets", async () => {
  const { app, repo } = setup();
  await repo.performance.set(PERFORMANCE_1);

  const result = await doExport(app, true);
  assertEquals(result.data.performance, [PERFORMANCE_1]);
});

// ---- Tests: round-trip (import → export) ----

test("round-trip — replace import then export yields equivalent data", async () => {
  const { app } = setup();

  const original = {
    apiKeys: [KEY_A, KEY_B],
    githubAccounts: [ACCOUNT_X, ACCOUNT_Y],
    usage: [USAGE_1, USAGE_2],
    searchUsage: [SEARCH_USAGE_1, SEARCH_USAGE_2],
    performance: [PERFORMANCE_1, PERFORMANCE_2],
  };

  const { status, body } = await doImport(app, "replace", original);
  assertEquals(status, 200);
  assertEquals(body.ok, true);
  assertEquals(body.imported, {
    apiKeys: 2,
    githubAccounts: 2,
    usage: 2,
    searchUsage: 2,
    upstreamConfigs: 0,
    performance: 2,
  });

  const exported = await doExport(app, true);

  // Sort for stable comparison
  const sortById = (a: { id: string }, b: { id: string }) =>
    a.id.localeCompare(b.id);
  const sortByUserId = (a: GitHubAccount, b: GitHubAccount) =>
    a.user.id - b.user.id;
  const sortByUsage = (a: UsageRecord, b: UsageRecord) =>
    a.hour.localeCompare(b.hour) || a.keyId.localeCompare(b.keyId);
  const sortBySearchUsage = (a: SearchUsageRecord, b: SearchUsageRecord) =>
    a.hour.localeCompare(b.hour) ||
    a.provider.localeCompare(b.provider) ||
    a.keyId.localeCompare(b.keyId);
  const sortByPerformance = (
    a: PerformanceTelemetryRecord,
    b: PerformanceTelemetryRecord,
  ) =>
    a.hour.localeCompare(b.hour) ||
    a.metricScope.localeCompare(b.metricScope) ||
    a.keyId.localeCompare(b.keyId) ||
    a.model.localeCompare(b.model);

  exported.data.apiKeys.sort(sortById);
  exported.data.githubAccounts.sort(sortByUserId);
  exported.data.usage.sort(sortByUsage);
  exported.data.searchUsage.sort(sortBySearchUsage);
  exported.data.performance.sort(sortByPerformance);

  const expected = { ...original };
  expected.apiKeys = [...original.apiKeys].sort(sortById);
  expected.githubAccounts = [...original.githubAccounts].sort(sortByUserId);
  expected.usage = [...original.usage].sort(sortByUsage);
  expected.searchUsage = [...original.searchUsage].sort(sortBySearchUsage);
  expected.performance = [...original.performance].sort(sortByPerformance);

  assertEquals(exported.data.apiKeys, expected.apiKeys);
  assertEquals(exported.data.githubAccounts, expected.githubAccounts);
  assertEquals(exported.data.usage, expected.usage);
  assertEquals(exported.data.searchUsage, expected.searchUsage);
  assertEquals(exported.data.performance, expected.performance);
});

test("round-trip — merge import then export contains both old and new data", async () => {
  const { app, repo } = setup();

  // Pre-existing data
  await repo.apiKeys.save(KEY_A);
  await repo.github.saveAccount(ACCOUNT_X.user.id, ACCOUNT_X);
  await repo.usage.set(USAGE_1);
  await repo.searchUsage.set(SEARCH_USAGE_1);
  await repo.performance.set(PERFORMANCE_1);

  // Merge new data
  const newData = {
    apiKeys: [KEY_B],
    githubAccounts: [ACCOUNT_Y],
    usage: [USAGE_2],
    searchUsage: [SEARCH_USAGE_2],
  };

  const { status } = await doImport(app, "merge", newData);
  assertEquals(status, 200);

  const exported = await doExport(app, true);

  assertEquals(exported.data.apiKeys.length, 2);
  assertEquals(exported.data.githubAccounts.length, 2);
  assertEquals(exported.data.usage.length, 2);
  assertEquals(exported.data.searchUsage.length, 2);
});

test("import replace — clears existing searchUsage before importing provided records", async () => {
  const { app, repo } = setup();

  await repo.searchUsage.set(SEARCH_USAGE_1);

  const { status, body } = await doImport(app, "replace", {
    searchUsage: [SEARCH_USAGE_2],
  });

  assertEquals(status, 200);
  assertEquals(body.imported.searchUsage, 1);

  const exported = await doExport(app, true);
  assertEquals(exported.data.searchUsage, [SEARCH_USAGE_2]);
});

test("import replace — clears existing performance before importing provided records", async () => {
  const { app, repo } = setup();

  await repo.performance.set(PERFORMANCE_1);

  const { status, body } = await doImport(app, "replace", {
    performance: [PERFORMANCE_2],
  });

  assertEquals(status, 200);
  assertEquals(body.imported.performance, 1);

  const exported = await doExport(app, true);
  assertEquals(exported.data.performance, [PERFORMANCE_2]);
});

test("import replace — preserves existing performance when payload omits performance", async () => {
  const { app, repo } = setup();

  await repo.performance.set(PERFORMANCE_1);

  const { status, body } = await doImport(app, "replace", {
    apiKeys: [KEY_B],
  });

  assertEquals(status, 200);
  assertEquals(body.imported.performance, 0);

  const exported = await doExport(app, true);
  assertEquals(exported.data.performance, [PERFORMANCE_1]);
});

test("import replace — preserves existing performance for legacy empty payloads without intent", async () => {
  const { app, repo } = setup();

  await repo.performance.set(PERFORMANCE_1);

  const { status, body } = await doImport(app, "replace", {
    performance: [],
  });

  assertEquals(status, 200);
  assertEquals(body.imported.performance, 0);

  const exported = await doExport(app, true);
  assertEquals(exported.data.performance, [PERFORMANCE_1]);
});

test("import replace — clears existing performance when explicitly included empty", async () => {
  const { app, repo } = setup();

  await repo.performance.set(PERFORMANCE_1);

  const { status, body } = await doImport(app, "replace", {
    performanceIncluded: true,
    performance: [],
  });

  assertEquals(status, 200);
  assertEquals(body.imported.performance, 0);

  const exported = await doExport(app, true);
  assertEquals(exported.data.performance, []);
});

test("import replace — accepts Gemini performance records", async () => {
  const { app } = setup();

  const { status, body } = await doImport(app, "replace", {
    performance: [PERFORMANCE_GEMINI],
  });

  assertEquals(status, 200);
  assertEquals(body.imported.performance, 1);

  const exported = await doExport(app, true);
  assertEquals(exported.data.performance, [PERFORMANCE_GEMINI]);
});

test("import replace — rejects invalid searchUsage before clearing existing data", async () => {
  const { app, repo } = setup();

  await repo.apiKeys.save(KEY_A);
  await repo.searchUsage.set(SEARCH_USAGE_1);

  const resp = await app.request("/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "replace",
      data: {
        searchUsage: [{
          provider: "disabled",
          keyId: "key-bad",
          hour: "2026-01-01T12",
          requests: 1,
        }],
      },
    }),
  });

  assertEquals(resp.status, 400);
  assertEquals(await resp.json(), {
    error: "invalid searchUsage record at index 0",
  });

  const exported = await doExport(app, true);
  assertEquals(exported.data.apiKeys, [KEY_A]);
  assertEquals(exported.data.searchUsage, [SEARCH_USAGE_1]);
});

test("import replace — rejects invalid performance before clearing existing data", async () => {
  const { app, repo } = setup();

  await repo.apiKeys.save(KEY_A);
  await repo.performance.set(PERFORMANCE_1);

  const resp = await app.request("/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "replace",
      data: {
        performance: [{ ...PERFORMANCE_2, metricScope: "bad" }],
      },
    }),
  });

  assertEquals(resp.status, 400);
  assertEquals(await resp.json(), {
    error: "invalid performance record at index 0",
  });

  const exported = await doExport(app, true);
  assertEquals(exported.data.apiKeys, [KEY_A]);
  assertEquals(exported.data.performance, [PERFORMANCE_1]);
});

test("export/import include searchConfig and replace it as a singleton when present", async () => {
  const { app, repo } = setup();

  await repo.searchConfig.save({
    provider: "tavily",
    tavily: { apiKey: "tvly-original" },
    microsoftGrounding: { apiKey: "ms-original" },
  });

  const exported = await doExport(app);
  assertEquals(exported.data.searchConfig.provider, "tavily");

  const { status } = await doImport(app, "merge", {
    apiKeys: [],
    githubAccounts: [],
    usage: [],
    searchConfig: {
      provider: "microsoft-grounding",
      tavily: { apiKey: "tvly-imported" },
      microsoftGrounding: { apiKey: "ms-imported" },
    },
  });

  assertEquals(status, 200);
  assertEquals(await repo.searchConfig.get(), {
    provider: "microsoft-grounding",
    tavily: { apiKey: "tvly-imported" },
    microsoftGrounding: { apiKey: "ms-imported" },
  });
});

test("import replace resets searchConfig to default when the payload omits it", async () => {
  const { app, repo } = setup();

  await repo.searchConfig.save({
    provider: "tavily",
    tavily: { apiKey: "tvly-original" },
    microsoftGrounding: { apiKey: "ms-original" },
  });

  const { status } = await doImport(app, "replace", {
    apiKeys: [],
    githubAccounts: [],
    usage: [],
  });

  assertEquals(status, 200);

  const exported = await doExport(app);
  assertEquals(exported.data.searchConfig, DEFAULT_SEARCH_CONFIG);
});

test("round-trip — double import with replace is idempotent", async () => {
  const { app } = setup();

  const data = {
    apiKeys: [KEY_A],
    githubAccounts: [ACCOUNT_X],
    usage: [USAGE_1],
  };

  await doImport(app, "replace", data);
  await doImport(app, "replace", data);

  const exported = await doExport(app);
  assertEquals(exported.data.apiKeys.length, 1);
  assertEquals(exported.data.githubAccounts.length, 1);
  assertEquals(exported.data.usage.length, 1);
});

test("round-trip — export from A, import into B, export from B matches A", async () => {
  // Simulate moving data between two deployments.
  const repoA = new InMemoryRepo();
  initRepo(repoA);
  const appA = new Hono();
  appA.get("/export", exportData);
  appA.post("/import", importData);

  await repoA.apiKeys.save(KEY_A);
  await repoA.apiKeys.save(KEY_B);
  await repoA.github.saveAccount(ACCOUNT_X.user.id, ACCOUNT_X);
  await repoA.usage.set(USAGE_1);
  await repoA.usage.set(USAGE_2);
  await repoA.searchUsage.set(SEARCH_USAGE_1);
  await repoA.searchUsage.set(SEARCH_USAGE_2);
  await repoA.performance.set(PERFORMANCE_1);
  await repoA.performance.set(PERFORMANCE_2);

  const exportA = await doExport(appA, true);

  // Platform B — fresh repo
  const repoB = new InMemoryRepo();
  initRepo(repoB);
  const appB = new Hono();
  appB.get("/export", exportData);
  appB.post("/import", importData);

  await doImport(appB, "replace", exportA.data);
  const exportB = await doExport(appB, true);

  // Compare data (ignoring exportedAt timestamp)
  const sortById = (a: { id: string }, b: { id: string }) =>
    a.id.localeCompare(b.id);
  const sortByUserId = (a: GitHubAccount, b: GitHubAccount) =>
    a.user.id - b.user.id;
  const sortByUsage = (a: UsageRecord, b: UsageRecord) =>
    a.hour.localeCompare(b.hour) || a.keyId.localeCompare(b.keyId);
  const sortBySearchUsage = (a: SearchUsageRecord, b: SearchUsageRecord) =>
    a.hour.localeCompare(b.hour) ||
    a.provider.localeCompare(b.provider) ||
    a.keyId.localeCompare(b.keyId);
  const sortByPerformance = (
    a: PerformanceTelemetryRecord,
    b: PerformanceTelemetryRecord,
  ) =>
    a.hour.localeCompare(b.hour) ||
    a.metricScope.localeCompare(b.metricScope) ||
    a.keyId.localeCompare(b.keyId) ||
    a.model.localeCompare(b.model);

  exportA.data.apiKeys.sort(sortById);
  exportA.data.githubAccounts.sort(sortByUserId);
  exportA.data.usage.sort(sortByUsage);
  exportA.data.searchUsage.sort(sortBySearchUsage);
  exportA.data.performance.sort(sortByPerformance);
  exportB.data.apiKeys.sort(sortById);
  exportB.data.githubAccounts.sort(sortByUserId);
  exportB.data.usage.sort(sortByUsage);
  exportB.data.searchUsage.sort(sortBySearchUsage);
  exportB.data.performance.sort(sortByPerformance);

  assertEquals(exportB.data.apiKeys, exportA.data.apiKeys);
  assertEquals(exportB.data.githubAccounts, exportA.data.githubAccounts);
  assertEquals(exportB.data.usage, exportA.data.usage);
  assertEquals(exportB.data.searchUsage, exportA.data.searchUsage);
  assertEquals(exportB.data.performance, exportA.data.performance);
});

// ---- Tests: import modes ----

test("import replace — clears existing data", async () => {
  const { app, repo } = setup();

  await repo.apiKeys.save(KEY_A);
  await repo.github.saveAccount(ACCOUNT_X.user.id, ACCOUNT_X);
  await repo.usage.set(USAGE_1);
  await repo.searchUsage.set(SEARCH_USAGE_1);

  // Replace with only KEY_B
  await doImport(app, "replace", {
    apiKeys: [KEY_B],
    githubAccounts: [],
    usage: [],
  });

  const exported = await doExport(app);
  assertEquals(exported.data.apiKeys.length, 1);
  assertEquals(exported.data.apiKeys[0].id, KEY_B.id);
  assertEquals(exported.data.githubAccounts.length, 0);
  assertEquals(exported.data.usage.length, 0);
  assertEquals(exported.data.searchUsage.length, 0);
  assertEquals(exported.data.performanceIncluded, false);
  assertEquals(hasOwn(exported.data, "performance"), false);
});

test("import merge — upserts existing records by key", async () => {
  const { app, repo } = setup();

  // Pre-existing KEY_A with old name
  await repo.apiKeys.save({ ...KEY_A, name: "OldName" });

  // Merge with KEY_A (new name) + KEY_B
  await doImport(app, "merge", {
    apiKeys: [KEY_A, KEY_B],
  });

  const exported = await doExport(app);
  assertEquals(exported.data.apiKeys.length, 2);
  const updatedA = exported.data.apiKeys.find((k: ApiKey) => k.id === KEY_A.id);
  assertEquals(updatedA.name, "Alice"); // updated to imported value
});

test("import merge — usage set overwrites matching records", async () => {
  const { app, repo } = setup();

  // Existing usage
  await repo.usage.set({
    ...USAGE_1,
    requests: 10,
    inputTokens: 9999,
    outputTokens: 8888,
  });

  // Merge with USAGE_1 (different values)
  await doImport(app, "merge", { usage: [USAGE_1] });

  const exported = await doExport(app);
  assertEquals(exported.data.usage.length, 1);
  assertEquals(exported.data.usage[0].requests, USAGE_1.requests); // 5, not 10
  assertEquals(exported.data.usage[0].inputTokens, USAGE_1.inputTokens);
});

// ---- Tests: validation ----

test("import — rejects invalid mode", async () => {
  const { app } = setup();
  const { status, body } = await doImport(app, "invalid", { apiKeys: [] });
  assertEquals(status, 400);
  assertEquals(body.error, "mode must be 'merge' or 'replace'");
});

test("import — rejects missing data", async () => {
  const { app } = setup();
  const resp = await app.request("/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "merge" }),
  });
  assertEquals(resp.status, 400);
  const body = await resp.json();
  assertEquals(body.error, "data is required");
});

test("import — handles missing optional arrays gracefully", async () => {
  const { app } = setup();
  // data object with no arrays
  const { status, body } = await doImport(app, "replace", {});
  assertEquals(status, 200);
  assertEquals(body.ok, true);
  assertEquals(body.imported, {
    apiKeys: 0,
    githubAccounts: 0,
    usage: 0,
    searchUsage: 0,
    upstreamConfigs: 0,
    performance: 0,
  });
});
