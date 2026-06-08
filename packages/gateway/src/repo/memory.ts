// In-memory repository implementation for testing

import { normalizeDisabledPublicModelIds } from './disabled-public-models.ts';
import { normalizeFlagOverrides } from './flag-overrides.ts';
import { RESPONSES_REFRESH_DEBOUNCE_MS } from './responses-payload.ts';
import type {
  ApiKey,
  ApiKeyRepo,
  CacheRepo,
  PerformanceDimensions,
  PerformanceErrorSample,
  PerformanceLatencySample,
  PerformanceRepo,
  PerformanceTelemetryRecord,
  Repo,
  ResponsesItemsRepo,
  ResponsesSnapshotsRepo,
  SearchConfigRepo,
  SearchUsageRecord,
  SearchUsageRepo,
  StoredResponsesItem,
  StoredResponsesSnapshot,
  UpstreamRepo,
  UsageRecord,
  UsageRepo,
} from './types.ts';
import { serializeStoredState } from './upstream-json.ts';
import { latencyBucketForMs } from '../shared/performance-histogram.ts';
import { assertWebSearchProviderName } from '../shared/web-search-providers.ts';
import { type BillingDimension, type ModelPricing, unitPriceForDimension } from '@floway-dev/protocols/common';
import type { UpstreamRecord } from '@floway-dev/provider';

const BILLING_DIMENSIONS: readonly BillingDimension[] = ['input', 'input_cache_read', 'input_cache_write', 'input_image', 'output', 'output_image'];

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

// Mirrors the D1 schema: one entry per (bucket, dimension) with a token count
// and a per-dimension unit_price snapshot, plus a separate request count per
// bucket. Records are reassembled into UsageRecord on read, folding the
// per-dimension unit prices back into a ModelPricing snapshot.
interface UsageBucketIdentity {
  keyId: string;
  model: string;
  upstream: string | null;
  modelKey: string;
  hour: string;
}

interface UsageBucketState extends UsageBucketIdentity {
  tokens: Partial<Record<BillingDimension, number>>;
  unitPrices: Partial<Record<BillingDimension, number>>;
  requests: number;
}

class MemoryUsageRepo implements UsageRepo {
  private store = new Map<string, UsageBucketState>();

  private key(r: { keyId: string; model: string; upstream: string | null; modelKey: string; hour: string }): string {
    return [r.keyId, r.model, r.upstream ?? '', r.modelKey, r.hour].join('\0');
  }

  private dimensionEntries(record: UsageRecord): { dimension: BillingDimension; tokens: number; unitPrice: number | null }[] {
    return BILLING_DIMENSIONS.flatMap(dimension => {
      const tokens = record.tokens[dimension] ?? 0;
      return tokens > 0 ? [{ dimension, tokens, unitPrice: unitPriceForDimension(record.cost, dimension) }] : [];
    });
  }

  private toRecord(state: UsageBucketState): UsageRecord {
    const tokens: Partial<Record<BillingDimension, number>> = {};
    let cost: ModelPricing | null = null;
    for (const dimension of BILLING_DIMENSIONS) {
      const count = state.tokens[dimension];
      if (count !== undefined) tokens[dimension] = count;
      const unitPrice = state.unitPrices[dimension];
      if (unitPrice !== undefined) (cost ??= {})[dimension] = unitPrice;
    }
    return { keyId: state.keyId, model: state.model, upstream: state.upstream ?? null, modelKey: state.modelKey, hour: state.hour, requests: state.requests, tokens, cost };
  }

  private bucket(record: UsageRecord): UsageBucketState {
    const k = this.key(record);
    let state = this.store.get(k);
    if (!state) {
      state = { keyId: record.keyId, model: record.model, upstream: record.upstream ?? null, modelKey: record.modelKey, hour: record.hour, tokens: {}, unitPrices: {}, requests: 0 };
      this.store.set(k, state);
    }
    return state;
  }

  record(record: UsageRecord): Promise<void> {
    const state = this.bucket(record);
    state.requests += record.requests;
    for (const { dimension, tokens, unitPrice } of this.dimensionEntries(record)) {
      state.tokens[dimension] = (state.tokens[dimension] ?? 0) + tokens;
      // COALESCE(unit_price, excluded.unit_price): keep the existing snapshot
      // once set, otherwise adopt the incoming price.
      if (state.unitPrices[dimension] === undefined && unitPrice !== null) state.unitPrices[dimension] = unitPrice;
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
        .map(r => this.toRecord(r))
        .sort((a, b) => a.hour.localeCompare(b.hour)),
    );
  }

  listAll(): Promise<UsageRecord[]> {
    return Promise.resolve([...this.store.values()].map(r => this.toRecord(r)).sort((a, b) => a.hour.localeCompare(b.hour)));
  }

  set(record: UsageRecord): Promise<void> {
    const k = this.key(record);
    const state: UsageBucketState = {
      keyId: record.keyId,
      model: record.model,
      upstream: record.upstream ?? null,
      modelKey: record.modelKey,
      hour: record.hour,
      tokens: {},
      unitPrices: {},
      requests: record.requests,
    };
    for (const { dimension, tokens, unitPrice } of this.dimensionEntries(record)) {
      state.tokens[dimension] = tokens;
      if (unitPrice !== null) state.unitPrices[dimension] = unitPrice;
    }
    this.store.set(k, state);
    return Promise.resolve();
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}

class MemorySearchUsageRepo implements SearchUsageRepo {
  private store = new Map<string, SearchUsageRecord>();

  private key(r: { provider: SearchUsageRecord['provider']; keyId: string; action: SearchUsageRecord['action']; hour: string }): string {
    return `${r.provider}\0${r.keyId}\0${r.action}\0${r.hour}`;
  }

  record(args: { provider: SearchUsageRecord['provider']; keyId: string; action: SearchUsageRecord['action']; hour: string; requests: number }): Promise<void> {
    return Promise.resolve().then(() => {
      const validProvider = assertWebSearchProviderName(args.provider);
      const k = this.key({ provider: validProvider, keyId: args.keyId, action: args.action, hour: args.hour });
      const existing = this.store.get(k);
      if (existing) {
        existing.requests += args.requests;
      } else {
        this.store.set(k, { provider: validProvider, keyId: args.keyId, action: args.action, hour: args.hour, requests: args.requests });
      }
    });
  }

  query(opts: { provider?: SearchUsageRecord['provider']; keyId?: string; action?: SearchUsageRecord['action']; start: string; end: string }): Promise<SearchUsageRecord[]> {
    return Promise.resolve().then(() => {
      const provider = opts.provider ? assertWebSearchProviderName(opts.provider) : undefined;
      return [...this.store.values()]
        .filter(r => !provider || r.provider === provider)
        .filter(r => !opts.keyId || r.keyId === opts.keyId)
        .filter(r => !opts.action || r.action === opts.action)
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

class MemoryUpstreamRepo implements UpstreamRepo {
  private store = new Map<string, UpstreamRecord>();

  list(): Promise<UpstreamRecord[]> {
    return Promise.resolve([...this.store.values()].map(cloneUpstreamRecord).sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt)));
  }

  getById(id: string): Promise<UpstreamRecord | null> {
    const found = this.store.get(id);
    return Promise.resolve(found ? cloneUpstreamRecord(found) : null);
  }

  save(upstream: UpstreamRecord): Promise<void> {
    const existing = this.store.get(upstream.id);
    const preserved = existing ? { ...upstream, createdAt: existing.createdAt } : upstream;
    this.store.set(preserved.id, cloneUpstreamRecord(preserved));
    return Promise.resolve();
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.store.delete(id));
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }

  // Mirrors the SQL CAS predicate by comparing the canonical JSON encoding of
  // the row's current state against the expected one — same encoding the SQL
  // impl writes, so callers see identical semantics across backends.
  saveState(id: string, newState: unknown, options: { expectedState: unknown }): Promise<{ updated: boolean }> {
    const existing = this.store.get(id);
    if (!existing) return Promise.resolve({ updated: false });
    if (serializeStoredState(existing.state) !== serializeStoredState(options.expectedState)) {
      return Promise.resolve({ updated: false });
    }
    existing.state = newState === undefined ? null : structuredClone(newState);
    return Promise.resolve({ updated: true });
  }
}

const cloneUpstreamRecord = (upstream: UpstreamRecord): UpstreamRecord => ({
  ...upstream,
  config: structuredClone(upstream.config),
  state: upstream.state === null || upstream.state === undefined ? null : structuredClone(upstream.state),
  flagOverrides: normalizeFlagOverrides(upstream.flagOverrides),
  disabledPublicModelIds: normalizeDisabledPublicModelIds(upstream.disabledPublicModelIds),
});

class MemoryResponsesItemsRepo implements ResponsesItemsRepo {
  private store = new Map<string, StoredResponsesItem>();

  lookupMany(apiKeyId: string | null, ids: readonly string[]): Promise<StoredResponsesItem[]> {
    const rows: StoredResponsesItem[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const row = this.store.get(responsesItemStoreKey(apiKeyId, id));
      if (row?.apiKeyId === apiKeyId) rows.push(cloneStoredResponsesItem(row));
    }
    return Promise.resolve(rows);
  }

  lookupManyByEncryptedContentHash(apiKeyId: string | null, hashes: readonly string[]): Promise<StoredResponsesItem[]> {
    const wanted = new Set(hashes);
    if (wanted.size === 0) return Promise.resolve([]);
    const rows: StoredResponsesItem[] = [];
    for (const row of this.store.values()) {
      if (row.apiKeyId === apiKeyId && row.encryptedContentHash !== null && wanted.has(row.encryptedContentHash)) {
        rows.push(cloneStoredResponsesItem(row));
      }
    }
    return Promise.resolve(rows.toSorted(compareResponsesItemsByFreshness));
  }

  lookupManyByContentHash(apiKeyId: string | null, hashes: readonly string[]): Promise<StoredResponsesItem[]> {
    const wanted = new Set(hashes);
    if (wanted.size === 0) return Promise.resolve([]);
    const rows: StoredResponsesItem[] = [];
    for (const row of this.store.values()) {
      if (row.apiKeyId === apiKeyId && row.contentHash !== null && wanted.has(row.contentHash)) {
        rows.push(cloneStoredResponsesItem(row));
      }
    }
    return Promise.resolve(rows.toSorted(compareResponsesItemsByFreshness));
  }

  insertMany(items: readonly StoredResponsesItem[]): Promise<void> {
    for (const item of items) {
      const key = responsesItemStoreKey(item.apiKeyId, item.id);
      if (this.store.has(key)) continue;
      this.store.set(key, cloneStoredResponsesItem(item));
    }
    return Promise.resolve();
  }

  fillPayloads(items: readonly StoredResponsesItem[]): Promise<number> {
    let changes = 0;
    for (const item of items) {
      if (item.payload === null) continue;
      const existing = this.store.get(responsesItemStoreKey(item.apiKeyId, item.id));
      if (existing?.payload !== null) continue;
      existing.payload = structuredClone(item.payload);
      existing.contentHash = item.contentHash;
      existing.encryptedContentHash = item.encryptedContentHash;
      existing.createdAt = item.createdAt;
      existing.refreshedAt = Math.max(existing.refreshedAt, item.refreshedAt);
      changes += 1;
    }
    return Promise.resolve(changes);
  }

  refreshMany(apiKeyId: string | null, ids: readonly string[], refreshedAt: number): Promise<number> {
    let changes = 0;
    const cutoff = refreshedAt - RESPONSES_REFRESH_DEBOUNCE_MS;
    for (const id of new Set(ids)) {
      const row = this.store.get(responsesItemStoreKey(apiKeyId, id));
      if (row && row.refreshedAt < cutoff) {
        row.refreshedAt = refreshedAt;
        changes += 1;
      }
    }
    return Promise.resolve(changes);
  }

  clearPayloadOlderThan(createdBefore: number): Promise<number> {
    let changes = 0;
    for (const row of this.store.values()) {
      if (row.createdAt < createdBefore && row.payload !== null) {
        row.payload = null;
        changes += 1;
      }
    }
    return Promise.resolve(changes);
  }

  deleteOlderThan(refreshedBefore: number): Promise<number> {
    let changes = 0;
    for (const [id, row] of this.store) {
      if (row.refreshedAt < refreshedBefore) {
        this.store.delete(id);
        changes += 1;
      }
    }
    return Promise.resolve(changes);
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}

const cloneStoredResponsesItem = (item: StoredResponsesItem): StoredResponsesItem => ({
  ...item,
  payload: item.payload === null ? null : structuredClone(item.payload),
});

class MemoryResponsesSnapshotsRepo implements ResponsesSnapshotsRepo {
  private store = new Map<string, StoredResponsesSnapshot>();

  lookup(apiKeyId: string | null, id: string): Promise<StoredResponsesSnapshot | null> {
    const snapshot = this.store.get(responsesItemStoreKey(apiKeyId, id));
    return Promise.resolve(snapshot ? cloneStoredResponsesSnapshot(snapshot) : null);
  }

  insert(snapshot: StoredResponsesSnapshot): Promise<void> {
    this.store.set(responsesItemStoreKey(snapshot.apiKeyId, snapshot.id), cloneStoredResponsesSnapshot(snapshot));
    return Promise.resolve();
  }

  refresh(apiKeyId: string | null, id: string, refreshedAt: number): Promise<boolean> {
    const snapshot = this.store.get(responsesItemStoreKey(apiKeyId, id));
    if (!snapshot || snapshot.refreshedAt >= refreshedAt - RESPONSES_REFRESH_DEBOUNCE_MS) return Promise.resolve(false);
    snapshot.refreshedAt = refreshedAt;
    return Promise.resolve(true);
  }

  deleteOlderThan(refreshedBefore: number): Promise<number> {
    let changes = 0;
    for (const [key, snapshot] of this.store) {
      if (snapshot.refreshedAt < refreshedBefore) {
        this.store.delete(key);
        changes += 1;
      }
    }
    return Promise.resolve(changes);
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}

const cloneStoredResponsesSnapshot = (snapshot: StoredResponsesSnapshot): StoredResponsesSnapshot => ({
  ...snapshot,
  itemIds: [...snapshot.itemIds],
});

const compareResponsesItemsByFreshness = (a: StoredResponsesItem, b: StoredResponsesItem): number =>
  b.refreshedAt - a.refreshedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id);

const responsesItemStoreKey = (apiKeyId: string | null, id: string): string => `${apiKeyId ?? ''}\0${id}`;

export class InMemoryRepo implements Repo {
  apiKeys: ApiKeyRepo;
  usage: UsageRepo;
  searchUsage: SearchUsageRepo;
  performance: PerformanceRepo;
  cache: CacheRepo;
  searchConfig: SearchConfigRepo;
  upstreams: UpstreamRepo;
  responsesItems: ResponsesItemsRepo;
  responsesSnapshots: ResponsesSnapshotsRepo;

  constructor() {
    this.apiKeys = new MemoryApiKeyRepo();
    this.usage = new MemoryUsageRepo();
    this.searchUsage = new MemorySearchUsageRepo();
    this.performance = new MemoryPerformanceRepo();
    this.cache = new MemoryCacheRepo();
    this.searchConfig = new MemorySearchConfigRepo();
    this.upstreams = new MemoryUpstreamRepo();
    this.responsesItems = new MemoryResponsesItemsRepo();
    this.responsesSnapshots = new MemoryResponsesSnapshotsRepo();
  }
}
