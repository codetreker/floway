// Data transfer routes — export/import all database data as JSON

import type { Context } from "hono";
import { normalizeSearchConfig } from "../../data-plane/tools/web-search/search-config.ts";
import type { SearchConfig } from "../../data-plane/tools/web-search/types.ts";
import { isWebSearchProviderName } from "../../shared/web-search-providers.ts";
import { invalidateUpstreamModels } from "../../data-plane/providers/upstream-model-cache.ts";
import { getRepo } from "../../repo/index.ts";
import type {
  ApiKey,
  GitHubAccount,
  PerformanceApiName,
  PerformanceMetricScope,
  PerformanceTelemetryRecord,
  SearchUsageRecord,
  UpstreamConfig,
  UsageRecord,
} from "../../repo/types.ts";

interface ExportPayload {
  version: 1;
  exportedAt: string;
  data: {
    apiKeys: ApiKey[];
    githubAccounts: GitHubAccount[];
    usage: UsageRecord[];
    searchUsage: SearchUsageRecord[];
    performance?: PerformanceTelemetryRecord[];
    performanceIncluded?: boolean;
    searchConfig: SearchConfig;
    upstreamConfigs: UpstreamConfig[];
  };
}

const SEARCH_USAGE_HOUR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
const PERFORMANCE_METRIC_SCOPES = new Set<PerformanceMetricScope>([
  "request_total",
  "upstream_success",
]);
const PERFORMANCE_API_NAMES = new Set<PerformanceApiName>([
  "messages",
  "responses",
  "chat-completions",
  "gemini",
  "embeddings",
]);

const hasOwn = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

const parseSearchUsageRecords = (
  value: unknown,
):
  | { type: "ok"; records: SearchUsageRecord[] }
  | { type: "invalid"; index: number } => {
  if (!Array.isArray(value)) return { type: "ok", records: [] };

  const records: SearchUsageRecord[] = [];
  for (let i = 0; i < value.length; i++) {
    const record = value[i];
    if (!record || typeof record !== "object") {
      return { type: "invalid", index: i };
    }

    const item = record as Record<string, unknown>;
    const provider = item.provider;
    const keyId = item.keyId;
    const hour = item.hour;
    const requests = item.requests;
    if (
      !isWebSearchProviderName(provider) ||
      typeof keyId !== "string" ||
      keyId.length === 0 ||
      typeof hour !== "string" ||
      !SEARCH_USAGE_HOUR_PATTERN.test(hour) ||
      typeof requests !== "number" ||
      !Number.isSafeInteger(requests) ||
      requests < 0
    ) {
      return { type: "invalid", index: i };
    }

    records.push({
      provider,
      keyId,
      hour,
      requests,
    });
  }

  return { type: "ok", records };
};

const parsePerformanceRecords = (
  value: unknown,
):
  | { type: "ok"; records: PerformanceTelemetryRecord[] }
  | { type: "invalid"; index: number } => {
  if (!Array.isArray(value)) return { type: "ok", records: [] };

  const records: PerformanceTelemetryRecord[] = [];
  for (let i = 0; i < value.length; i++) {
    const record = value[i];
    if (!record || typeof record !== "object") {
      return { type: "invalid", index: i };
    }

    const item = record as Record<string, unknown>;
    if (
      typeof item.hour !== "string" ||
      !SEARCH_USAGE_HOUR_PATTERN.test(item.hour) ||
      !isPerformanceMetricScope(item.metricScope) ||
      typeof item.keyId !== "string" ||
      item.keyId.length === 0 ||
      typeof item.model !== "string" ||
      item.model.length === 0 ||
      (item.upstream !== null && typeof item.upstream !== "string") ||
      typeof item.modelKey !== "string" ||
      item.modelKey.length === 0 ||
      !isPerformanceApiName(item.sourceApi) ||
      !isPerformanceApiName(item.targetApi) ||
      typeof item.stream !== "boolean" ||
      typeof item.runtimeLocation !== "string" ||
      item.runtimeLocation.length === 0 ||
      !isNonNegativeSafeInteger(item.requests) ||
      !isNonNegativeSafeInteger(item.errors) ||
      !isNonNegativeSafeInteger(item.totalMsSum) ||
      !Array.isArray(item.buckets)
    ) {
      return { type: "invalid", index: i };
    }

    const buckets = [];
    for (const bucket of item.buckets) {
      if (!bucket || typeof bucket !== "object") {
        return { type: "invalid", index: i };
      }
      const bucketItem = bucket as Record<string, unknown>;
      if (
        !isNonNegativeSafeInteger(bucketItem.lowerMs) ||
        !isNonNegativeSafeInteger(bucketItem.upperMs) ||
        !isNonNegativeSafeInteger(bucketItem.count) ||
        bucketItem.upperMs <= bucketItem.lowerMs
      ) {
        return { type: "invalid", index: i };
      }
      buckets.push({
        lowerMs: bucketItem.lowerMs,
        upperMs: bucketItem.upperMs,
        count: bucketItem.count,
      });
    }

    records.push({
      hour: item.hour,
      metricScope: item.metricScope,
      keyId: item.keyId,
      model: item.model,
      upstream: item.upstream as string | null,
      modelKey: item.modelKey,
      sourceApi: item.sourceApi,
      targetApi: item.targetApi,
      stream: item.stream,
      runtimeLocation: item.runtimeLocation,
      requests: item.requests,
      errors: item.errors,
      totalMsSum: item.totalMsSum,
      buckets,
    });
  }

  return { type: "ok", records };
};

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isPerformanceMetricScope = (
  value: unknown,
): value is PerformanceMetricScope =>
  typeof value === "string" &&
  PERFORMANCE_METRIC_SCOPES.has(value as PerformanceMetricScope);

const isPerformanceApiName = (value: unknown): value is PerformanceApiName =>
  typeof value === "string" &&
  PERFORMANCE_API_NAMES.has(value as PerformanceApiName);

/** GET /api/export — dump all data as JSON */
export const exportData = async (c: Context) => {
  const repo = getRepo();
  const includePerformance = c.req.query("include_performance") === "1";

  const [
    apiKeys,
    githubAccounts,
    usage,
    searchUsage,
    performance,
    rawSearchConfig,
    upstreamConfigs,
  ] = await Promise.all([
    repo.apiKeys.list(),
    repo.github.listAccounts(),
    repo.usage.listAll(),
    repo.searchUsage.listAll(),
    includePerformance ? repo.performance.listAll() : Promise.resolve([]),
    repo.searchConfig.get(),
    repo.upstreamConfigs.list(),
  ]);

  const payload: ExportPayload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      apiKeys,
      githubAccounts,
      usage,
      searchUsage,
      performanceIncluded: includePerformance,
      searchConfig: normalizeSearchConfig(rawSearchConfig),
      upstreamConfigs,
    },
  };
  if (includePerformance) payload.data.performance = performance;

  return c.json(payload);
};

/** POST /api/import — import data with merge or replace mode */
export const importData = async (c: Context) => {
  const body = await c.req.json<{ mode: string; data: any }>();
  const { mode, data } = body;

  if (mode !== "merge" && mode !== "replace") {
    return c.json({ error: "mode must be 'merge' or 'replace'" }, 400);
  }
  if (!data || typeof data !== "object") {
    return c.json({ error: "data is required" }, 400);
  }

  const repo = getRepo();
  const apiKeys: ApiKey[] = Array.isArray(data.apiKeys) ? data.apiKeys : [];
  const githubAccounts: GitHubAccount[] = Array.isArray(data.githubAccounts)
    ? data.githubAccounts
    : [];
  const usage: UsageRecord[] = Array.isArray(data.usage) ? data.usage : [];
  const upstreamConfigs: UpstreamConfig[] = Array.isArray(data.upstreamConfigs)
    ? data.upstreamConfigs
    : [];
  const searchUsageResult = parseSearchUsageRecords(data.searchUsage);
  if (searchUsageResult.type === "invalid") {
    return c.json({
      error: `invalid searchUsage record at index ${searchUsageResult.index}`,
    }, 400);
  }
  const searchUsage = searchUsageResult.records;
  const performanceIncluded = shouldImportPerformance(data);
  const performanceResult = performanceIncluded
    ? parsePerformanceRecords(data.performance)
    : { type: "ok" as const, records: [] };
  if (performanceResult.type === "invalid") {
    return c.json({
      error: `invalid performance record at index ${performanceResult.index}`,
    }, 400);
  }
  const performance = performanceResult.records;
  if (mode === "replace") {
    // Collect existing upstream IDs before deletion so their stale model caches
    // can be invalidated — otherwise the L1/L2 models:<id> entries linger up to
    // HARD_TTL and feed routing and /v1/models with data from the old config.
    const existingUpstreams = await repo.upstreamConfigs.list();
    const deletes = [
      repo.apiKeys.deleteAll(),
      repo.github.deleteAllAccounts(),
      repo.usage.deleteAll(),
      repo.searchUsage.deleteAll(),
      repo.upstreamConfigs.deleteAll(),
    ];
    if (performanceIncluded) deletes.push(repo.performance.deleteAll());
    await Promise.all(deletes);
    await Promise.all(
      existingUpstreams.map((cfg) => invalidateUpstreamModels(cfg.id)),
    );
    await Promise.all([
      repo.searchConfig.save(normalizeSearchConfig(data.searchConfig)),
    ]);
  }

  // Import API keys
  for (const key of apiKeys) {
    await repo.apiKeys.save(key);
  }

  // Import GitHub accounts
  for (const account of githubAccounts) {
    await repo.github.saveAccount(account.user.id, account);
  }

  // Import usage records
  for (const record of usage) {
    await repo.usage.set(record);
  }

  // Import search usage records
  for (const record of searchUsage) {
    await repo.searchUsage.set(record);
  }

  // Import upstream configs
  for (const config of upstreamConfigs) {
    await repo.upstreamConfigs.save(config);
    await invalidateUpstreamModels(config.id);
  }

  // Import performance telemetry records
  for (const record of performance) {
    await repo.performance.set(record);
  }

  if (
    mode !== "replace" &&
    typeof data.searchConfig === "object" &&
    data.searchConfig !== null
  ) {
    await repo.searchConfig.save(normalizeSearchConfig(data.searchConfig));
  }

  return c.json({
    ok: true,
    imported: {
      apiKeys: apiKeys.length,
      githubAccounts: githubAccounts.length,
      usage: usage.length,
      searchUsage: searchUsage.length,
      upstreamConfigs: upstreamConfigs.length,
      performance: performance.length,
    },
  });
};

function shouldImportPerformance(data: Record<string, unknown>): boolean {
  if (data.performanceIncluded === true) return true;
  if (!hasOwn(data, "performance")) return false;

  // Performance export is opt-in because the histogram history can be large.
  // Before that intent was explicit, default exports wrote `performance: []`;
  // treating legacy empty arrays as omitted avoids silent telemetry loss on
  // replace import. Non-empty or invalid provided values are still treated as
  // intentional so real payloads import and malformed payloads are rejected.
  return !Array.isArray(data.performance) || data.performance.length > 0;
}
