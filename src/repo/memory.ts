// In-memory repository implementation for testing

import type {
  ApiKey,
  ApiKeyRepo,
  CacheRepo,
  GitHubAccount,
  GitHubRepo,
  PerformanceDimensions,
  PerformanceErrorSample,
  PerformanceLatencySample,
  PerformanceRepo,
  PerformanceTelemetryRecord,
  Repo,
  SearchConfigRepo,
  SearchUsageRecord,
  SearchUsageRepo,
  UpstreamConfig,
  UpstreamConfigRepo,
  UsageRecord,
  UsageRepo,
} from './types.ts';
import { latencyBucketForMs } from '../shared/performance-histogram.ts';
import { assertWebSearchProviderName } from '../shared/web-search-providers.ts';

class MemoryApiKeyRepo implements ApiKeyRepo {
  private store = new Map<string, ApiKey>();

  list(): Promise<ApiKey[]> {
    return Promise.resolve([...this.store.values()]);
  }

  findByRawKey(rawKey: string): Promise<ApiKey | null> {
    for (const key of this.store.values()) {
      if (key.key === rawKey) return Promise.resolve(key);
    }
    return Promise.resolve(null);
  }

  getById(id: string): Promise<ApiKey | null> {
    return Promise.resolve(this.store.get(id) ?? null);
  }

  save(key: ApiKey): Promise<void> {
    this.store.set(key.id, { ...key });
    return Promise.resolve();
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.store.delete(id));
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}

class MemoryGitHubRepo implements GitHubRepo {
  private accounts = new Map<number, GitHubAccount>();
  private order: number[] = [];

  listAccounts(): Promise<GitHubAccount[]> {
    const rank = new Map(this.order.map((id, index) => [id, index]));
    return Promise.resolve([...this.accounts.values()].sort((a, b) => (rank.get(a.user.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.user.id) ?? Number.MAX_SAFE_INTEGER) || a.user.id - b.user.id));
  }

  getAccount(userId: number): Promise<GitHubAccount | null> {
    return Promise.resolve(this.accounts.get(userId) ?? null);
  }

  saveAccount(userId: number, account: GitHubAccount): Promise<void> {
    this.accounts.set(userId, { ...account, user: { ...account.user } });
    if (!this.order.includes(userId)) this.order.push(userId);
    return Promise.resolve();
  }

  deleteAccount(userId: number): Promise<void> {
    this.accounts.delete(userId);
    this.order = this.order.filter(id => id !== userId);
    return Promise.resolve();
  }

  setOrder(userIds: number[]): Promise<void> {
    const seen = new Set<number>();
    const ordered = userIds.filter(id => {
      if (!this.accounts.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const rest = [...this.accounts.keys()].filter(id => !seen.has(id)).sort((a, b) => a - b);
    this.order = [...ordered, ...rest];
    return Promise.resolve();
  }

  deleteAllAccounts(): Promise<void> {
    this.accounts.clear();
    this.order = [];
    return Promise.resolve();
  }
}

class MemoryUsageRepo implements UsageRepo {
  private store = new Map<string, UsageRecord>();

  private key(r: { keyId: string; model: string; upstream: string | null; modelKey: string; hour: string }): string {
    return [r.keyId, r.model, r.upstream ?? '', r.modelKey, r.hour].join('\0');
  }

  private normalize(record: UsageRecord): UsageRecord {
    return {
      ...record,
      upstream: record.upstream ?? null,
      cacheReadTokens: record.cacheReadTokens ?? 0,
      cacheCreationTokens: record.cacheCreationTokens ?? 0,
    };
  }

  record(
    keyId: string,
    model: string,
    upstream: string | null,
    modelKey: string,
    hour: string,
    requests: number,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
    cacheCreationTokens = 0,
  ): Promise<void> {
    const k = this.key({ keyId, model, upstream, modelKey, hour });
    const existing = this.store.get(k);
    if (existing) {
      existing.requests += requests;
      existing.inputTokens += inputTokens;
      existing.outputTokens += outputTokens;
      existing.cacheReadTokens = (existing.cacheReadTokens ?? 0) + cacheReadTokens;
      existing.cacheCreationTokens = (existing.cacheCreationTokens ?? 0) + cacheCreationTokens;
    } else {
      this.store.set(
        k,
        this.normalize({
          keyId,
          model,
          upstream,
          modelKey,
          hour,
          requests,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
        }),
      );
    }
    return Promise.resolve();
  }

  query(opts: { keyId?: string; start: string; end: string }): Promise<UsageRecord[]> {
    return Promise.resolve(
      [...this.store.values()]
        .filter(r => {
          if (opts.keyId && r.keyId !== opts.keyId) return false;
          return r.hour >= opts.start && r.hour < opts.end;
        })
        .map(r => this.normalize(r))
        .sort((a, b) => a.hour.localeCompare(b.hour)),
    );
  }

  listAll(): Promise<UsageRecord[]> {
    return Promise.resolve([...this.store.values()].map(r => this.normalize(r)).sort((a, b) => a.hour.localeCompare(b.hour)));
  }

  set(record: UsageRecord): Promise<void> {
    this.store.set(this.key(record), this.normalize(record));
    return Promise.resolve();
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}

class MemorySearchUsageRepo implements SearchUsageRepo {
  private store = new Map<string, SearchUsageRecord>();

  private key(r: { provider: SearchUsageRecord['provider']; keyId: string; hour: string }): string {
    return `${r.provider}\0${r.keyId}\0${r.hour}`;
  }

  record(provider: SearchUsageRecord['provider'], keyId: string, hour: string, requests: number): Promise<void> {
    return Promise.resolve().then(() => {
      const validProvider = assertWebSearchProviderName(provider);
      const k = this.key({ provider: validProvider, keyId, hour });
      const existing = this.store.get(k);
      if (existing) {
        existing.requests += requests;
      } else {
        this.store.set(k, { provider: validProvider, keyId, hour, requests });
      }
    });
  }

  query(opts: { provider?: SearchUsageRecord['provider']; keyId?: string; start: string; end: string }): Promise<SearchUsageRecord[]> {
    return Promise.resolve().then(() => {
      const provider = opts.provider ? assertWebSearchProviderName(opts.provider) : undefined;
      return [...this.store.values()]
        .filter(r => !provider || r.provider === provider)
        .filter(r => !opts.keyId || r.keyId === opts.keyId)
        .filter(r => r.hour >= opts.start && r.hour < opts.end)
        .map(r => ({ ...r }))
        .sort((a, b) => a.hour.localeCompare(b.hour));
    });
  }

  listAll(): Promise<SearchUsageRecord[]> {
    return Promise.resolve([...this.store.values()].map(r => ({ ...r })).sort((a, b) => a.hour.localeCompare(b.hour)));
  }

  set(record: SearchUsageRecord): Promise<void> {
    return Promise.resolve().then(() => {
      const provider = assertWebSearchProviderName(record.provider);
      const validRecord = { ...record, provider };
      this.store.set(this.key(validRecord), validRecord);
    });
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}

class MemoryPerformanceRepo implements PerformanceRepo {
  private summaries = new Map<string, PerformanceTelemetryRecord>();

  private key(r: PerformanceDimensions): string {
    return [r.hour, r.metricScope, r.keyId, r.model, r.upstream ?? '', r.modelKey, r.sourceApi, r.targetApi, r.stream ? '1' : '0', r.runtimeLocation].join('\0');
  }

  private summary(sample: PerformanceDimensions): PerformanceTelemetryRecord {
    const key = this.key(sample);
    let record = this.summaries.get(key);
    if (!record) {
      record = {
        hour: sample.hour,
        metricScope: sample.metricScope,
        keyId: sample.keyId,
        model: sample.model,
        upstream: sample.upstream ?? null,
        modelKey: sample.modelKey,
        sourceApi: sample.sourceApi,
        targetApi: sample.targetApi,
        stream: sample.stream,
        runtimeLocation: sample.runtimeLocation,
        requests: 0,
        errors: 0,
        totalMsSum: 0,
        buckets: [],
      };
      this.summaries.set(key, record);
    }
    return record;
  }

  recordLatency(sample: PerformanceLatencySample): Promise<void> {
    const record = this.summary(sample);
    const durationMs = Math.max(0, Math.round(sample.durationMs));
    record.requests += 1;
    record.totalMsSum += durationMs;

    const bucket = latencyBucketForMs(durationMs);
    const existing = record.buckets.find(b => b.lowerMs === bucket.lowerMs && b.upperMs === bucket.upperMs);
    if (existing) {
      existing.count += 1;
    } else {
      record.buckets.push({ ...bucket, count: 1 });
      record.buckets.sort((a, b) => a.upperMs - b.upperMs || a.lowerMs - b.lowerMs);
    }
    return Promise.resolve();
  }

  recordError(sample: PerformanceErrorSample): Promise<void> {
    this.summary(sample).errors += 1;
    return Promise.resolve();
  }

  query(opts: { keyId?: string; metricScope?: PerformanceTelemetryRecord['metricScope']; start: string; end: string }): Promise<PerformanceTelemetryRecord[]> {
    return Promise.resolve(
      [...this.summaries.values()]
        .filter(r => r.hour >= opts.start && r.hour < opts.end)
        .filter(r => !opts.keyId || r.keyId === opts.keyId)
        .filter(r => !opts.metricScope || r.metricScope === opts.metricScope)
        .map(r => ({ ...r, buckets: r.buckets.map(b => ({ ...b })) }))
        .sort(comparePerformanceTelemetryRecords),
    );
  }

  listAll(): Promise<PerformanceTelemetryRecord[]> {
    return Promise.resolve([...this.summaries.values()].map(r => ({ ...r, buckets: r.buckets.map(b => ({ ...b })) })).sort(comparePerformanceTelemetryRecords));
  }

  set(record: PerformanceTelemetryRecord): Promise<void> {
    this.summaries.set(this.key(record), {
      ...record,
      buckets: record.buckets.map(bucket => ({ ...bucket })).sort((a, b) => a.upperMs - b.upperMs || a.lowerMs - b.lowerMs),
    });
    return Promise.resolve();
  }

  deleteAll(): Promise<void> {
    this.summaries.clear();
    return Promise.resolve();
  }
}

function comparePerformanceTelemetryRecords(a: PerformanceTelemetryRecord, b: PerformanceTelemetryRecord): number {
  return (
    a.hour.localeCompare(b.hour) ||
    a.metricScope.localeCompare(b.metricScope) ||
    a.keyId.localeCompare(b.keyId) ||
    a.model.localeCompare(b.model) ||
    (a.upstream ?? '').localeCompare(b.upstream ?? '') ||
    a.modelKey.localeCompare(b.modelKey) ||
    a.sourceApi.localeCompare(b.sourceApi) ||
    a.targetApi.localeCompare(b.targetApi) ||
    Number(a.stream) - Number(b.stream) ||
    a.runtimeLocation.localeCompare(b.runtimeLocation)
  );
}

class MemoryCacheRepo implements CacheRepo {
  private store = new Map<string, { value: string; expiresAt?: number }>();

  get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return Promise.resolve(null);

    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return Promise.resolve(null);
    }

    return Promise.resolve(entry.value);
  }

  set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.store.set(key, ttlMs ? { value, expiresAt: Date.now() + ttlMs } : { value });

    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }

  deletePrefix(prefix: string): Promise<void> {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
    return Promise.resolve();
  }
}

class MemorySearchConfigRepo implements SearchConfigRepo {
  private config: unknown | null = null;

  get(): Promise<unknown | null> {
    return Promise.resolve(this.config === null ? null : structuredClone(this.config));
  }

  save(config: unknown): Promise<void> {
    this.config = config === undefined ? null : structuredClone(config);
    return Promise.resolve();
  }
}

class MemoryUpstreamConfigRepo implements UpstreamConfigRepo {
  private store = new Map<string, UpstreamConfig>();

  list(): Promise<UpstreamConfig[]> {
    return Promise.resolve([...this.store.values()].map(cloneUpstreamConfig).sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt)));
  }

  getById(id: string): Promise<UpstreamConfig | null> {
    const found = this.store.get(id);
    return Promise.resolve(found ? cloneUpstreamConfig(found) : null);
  }

  save(config: UpstreamConfig): Promise<void> {
    this.store.set(config.id, cloneUpstreamConfig(config));
    return Promise.resolve();
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.store.delete(id));
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}

const cloneUpstreamConfig = (config: UpstreamConfig): UpstreamConfig => ({
  ...config,
  supportedEndpoints: [...config.supportedEndpoints],
  enabledFixes: [...config.enabledFixes],
  ...(config.pathOverrides ? { pathOverrides: { ...config.pathOverrides } } : {}),
});

export class InMemoryRepo implements Repo {
  apiKeys: ApiKeyRepo;
  github: GitHubRepo;
  usage: UsageRepo;
  searchUsage: SearchUsageRepo;
  performance: PerformanceRepo;
  cache: CacheRepo;
  searchConfig: SearchConfigRepo;
  upstreamConfigs: UpstreamConfigRepo;

  constructor() {
    this.apiKeys = new MemoryApiKeyRepo();
    this.github = new MemoryGitHubRepo();
    this.usage = new MemoryUsageRepo();
    this.searchUsage = new MemorySearchUsageRepo();
    this.performance = new MemoryPerformanceRepo();
    this.cache = new MemoryCacheRepo();
    this.searchConfig = new MemorySearchConfigRepo();
    this.upstreamConfigs = new MemoryUpstreamConfigRepo();
  }
}
