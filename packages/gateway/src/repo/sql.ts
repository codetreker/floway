import { normalizeDisabledPublicModelIds } from './disabled-public-models.ts';
import { normalizeFlagOverrides } from './flag-overrides.ts';
import { deleteAllResponsesItemPayloadFiles, parseStoredResponsesPayload, RESPONSES_REFRESH_DEBOUNCE_MS, serializeStoredResponsesPayload } from './responses-payload.ts';
import type {
  ApiKey,
  ApiKeyRepo,
  CacheRepo,
  PerformanceDimensions,
  PerformanceErrorSample,
  PerformanceLatencySample,
  PerformanceMetricScope,
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
import { serializeStoredConfig, serializeStoredState } from './upstream-json.ts';
import { latencyBucketForMs } from '../shared/performance-histogram.ts';
import { assertWebSearchProviderName } from '../shared/web-search-providers.ts';
import type { SqlDatabase, SqlPreparedStatement, SqlResult } from '@floway-dev/platform';
import { type BillingDimension, type ModelPricing, unitPriceForDimension } from '@floway-dev/protocols/common';
import type { UpstreamProviderKind, UpstreamRecord } from '@floway-dev/provider';

const SEARCH_CONFIG_KEY = 'search_config';

// Apply a list of prepared statements, using `db.batch` when available
// (D1 ships it; SqlDatabase models it as optional) and falling back to a
// sequential `run()` per statement otherwise. Empty input is a no-op.
const runStatements = async (db: SqlDatabase, statements: SqlPreparedStatement[]): Promise<SqlResult[]> => {
  if (statements.length === 0) return [];
  if (db.batch) return await db.batch(statements);
  const results: SqlResult[] = [];
  for (const statement of statements) results.push(await statement.run());
  return results;
};

class SqlApiKeyRepo implements ApiKeyRepo {
  constructor(private db: SqlDatabase) {}

  async list(): Promise<ApiKey[]> {
    const { results } = await this.db.prepare('SELECT id, name, key, created_at, last_used_at, upstream_ids FROM api_keys ORDER BY created_at').all<ApiKeyRow>();
    return results.map(toApiKey);
  }

  async findByRawKey(rawKey: string): Promise<ApiKey | null> {
    const row = await this.db.prepare('SELECT id, name, key, created_at, last_used_at, upstream_ids FROM api_keys WHERE key = ?').bind(rawKey).first<ApiKeyRow>();
    return row ? toApiKey(row) : null;
  }

  async getById(id: string): Promise<ApiKey | null> {
    const row = await this.db.prepare('SELECT id, name, key, created_at, last_used_at, upstream_ids FROM api_keys WHERE id = ?').bind(id).first<ApiKeyRow>();
    return row ? toApiKey(row) : null;
  }

  async save(key: ApiKey): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO api_keys (id, name, key, created_at, last_used_at, upstream_ids) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, key = excluded.key, last_used_at = excluded.last_used_at, upstream_ids = excluded.upstream_ids`,
      )
      .bind(key.id, key.name, key.key, key.createdAt, key.lastUsedAt ?? null, serializeUpstreamIds(key.upstreamIds))
      .run();
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM api_keys WHERE id = ?').bind(id).run();
    return ((result.meta.changes as number) ?? 0) > 0;
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM api_keys').run();
  }
}

interface ApiKeyRow {
  id: string;
  name: string;
  key: string;
  created_at: string;
  last_used_at: string | null;
  upstream_ids: string | null;
}

const serializeUpstreamIds = (value: readonly string[] | null): string | null => (value === null ? null : JSON.stringify(value));

// Throws rather than returning null on bad data: a silent downgrade to Default
// would grant the key broader provider access than the admin intended.
const parseUpstreamIds = (raw: string | null, keyId: string): string[] | null => {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`api_keys.upstream_ids JSON is malformed for id=${keyId}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`api_keys.upstream_ids is not an array for id=${keyId}`);
  if (!parsed.every(item => typeof item === 'string')) throw new Error(`api_keys.upstream_ids contains non-string entries for id=${keyId}`);
  return parsed as string[];
};

function toApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
    upstreamIds: parseUpstreamIds(row.upstream_ids, row.id),
  };
}

const BILLING_DIMENSIONS: readonly BillingDimension[] = ['input', 'input_cache_read', 'input_cache_write', 'input_image', 'output', 'output_image'];

const dimensionRows = (record: UsageRecord): { dimension: BillingDimension; tokens: number; unitPrice: number | null }[] =>
  BILLING_DIMENSIONS.flatMap(dimension => {
    const tokens = record.tokens[dimension] ?? 0;
    return tokens > 0 ? [{ dimension, tokens, unitPrice: unitPriceForDimension(record.cost, dimension) }] : [];
  });

class SqlUsageRepo implements UsageRepo {
  constructor(private db: SqlDatabase) {}

  async record(record: UsageRecord): Promise<void> {
    const upstream = record.upstream ?? null;
    const statements: SqlPreparedStatement[] = dimensionRows(record).map(row =>
      this.db
        .prepare(
          `INSERT INTO usage (key_id, model, upstream, model_key, hour, dimension, tokens, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO UPDATE SET
             tokens = tokens + excluded.tokens,
             unit_price = COALESCE(unit_price, excluded.unit_price)`,
        )
        .bind(record.keyId, record.model, upstream, record.modelKey, record.hour, row.dimension, row.tokens, row.unitPrice));
    statements.push(
      this.db
        .prepare(
          `INSERT INTO usage_requests (key_id, model, upstream, model_key, hour, requests) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT DO UPDATE SET requests = requests + excluded.requests`,
        )
        .bind(record.keyId, record.model, upstream, record.modelKey, record.hour, record.requests),
    );
    await runStatements(this.db, statements);
  }

  async query(opts: { keyId?: string; start: string; end: string }): Promise<UsageRecord[]> {
    const dimensionWhere = opts.keyId ? 'key_id = ? AND hour >= ? AND hour < ?' : 'hour >= ? AND hour < ?';
    const binds = opts.keyId ? [opts.keyId, opts.start, opts.end] : [opts.start, opts.end];
    const [{ results: dimensions }, { results: requests }] = await Promise.all([
      this.db
        .prepare(`SELECT key_id, model, upstream, model_key, hour, dimension, tokens, unit_price FROM usage WHERE ${dimensionWhere}`)
        .bind(...binds)
        .all<UsageDimensionRow>(),
      this.db
        .prepare(`SELECT key_id, model, upstream, model_key, hour, requests FROM usage_requests WHERE ${dimensionWhere}`)
        .bind(...binds)
        .all<UsageRequestRow>(),
    ]);
    return assembleUsageRecords(dimensions, requests);
  }

  async listAll(): Promise<UsageRecord[]> {
    const [{ results: dimensions }, { results: requests }] = await Promise.all([
      this.db.prepare('SELECT key_id, model, upstream, model_key, hour, dimension, tokens, unit_price FROM usage').all<UsageDimensionRow>(),
      this.db.prepare('SELECT key_id, model, upstream, model_key, hour, requests FROM usage_requests').all<UsageRequestRow>(),
    ]);
    return assembleUsageRecords(dimensions, requests);
  }

  async set(record: UsageRecord): Promise<void> {
    const upstream = record.upstream ?? null;
    // Replacement upsert: clear the bucket's existing dimension rows first so
    // dimensions absent from the new record do not linger.
    const statements: SqlPreparedStatement[] = [
      this.db
        .prepare("DELETE FROM usage WHERE key_id = ? AND model = ? AND COALESCE(upstream, '') = COALESCE(?, '') AND model_key = ? AND hour = ?")
        .bind(record.keyId, record.model, upstream, record.modelKey, record.hour),
      ...dimensionRows(record).map(row =>
        this.db
          .prepare('INSERT INTO usage (key_id, model, upstream, model_key, hour, dimension, tokens, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(record.keyId, record.model, upstream, record.modelKey, record.hour, row.dimension, row.tokens, row.unitPrice)),
    ];
    statements.push(
      this.db
        .prepare(
          `INSERT INTO usage_requests (key_id, model, upstream, model_key, hour, requests) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT DO UPDATE SET requests = excluded.requests`,
        )
        .bind(record.keyId, record.model, upstream, record.modelKey, record.hour, record.requests),
    );
    await runStatements(this.db, statements);
  }

  async deleteAll(): Promise<void> {
    await runStatements(this.db, [this.db.prepare('DELETE FROM usage'), this.db.prepare('DELETE FROM usage_requests')]);
  }
}

interface UsageDimensionRow {
  key_id: string;
  model: string;
  upstream: string | null;
  model_key: string;
  hour: string;
  dimension: string;
  tokens: number;
  unit_price: number | null;
}

interface UsageRequestRow {
  key_id: string;
  model: string;
  upstream: string | null;
  model_key: string;
  hour: string;
  requests: number;
}

const usageBucketKey = (row: { key_id: string; model: string; upstream: string | null; model_key: string; hour: string }): string =>
  [row.key_id, row.model, row.upstream ?? '', row.model_key, row.hour].join('\0');

// Reassemble per-bucket UsageRecords from the two narrow tables. The dimension
// rows carry the disjoint counts and the per-dimension unit_price snapshot,
// which we fold back into a ModelPricing snapshot; usage_requests carries the
// request count. A bucket may appear in either table independently.
const assembleUsageRecords = (dimensions: readonly UsageDimensionRow[], requests: readonly UsageRequestRow[]): UsageRecord[] => {
  const byBucket = new Map<string, UsageRecord>();

  const ensureRecord = (row: { key_id: string; model: string; upstream: string | null; model_key: string; hour: string }): UsageRecord => {
    const key = usageBucketKey(row);
    let record = byBucket.get(key);
    if (!record) {
      record = { keyId: row.key_id, model: row.model, upstream: row.upstream ?? null, modelKey: row.model_key, hour: row.hour, requests: 0, tokens: {}, cost: null };
      byBucket.set(key, record);
    }
    return record;
  };

  const pricingByBucket = new Map<string, ModelPricing>();
  for (const row of dimensions) {
    const record = ensureRecord(row);
    record.tokens[row.dimension as BillingDimension] = row.tokens;
    if (row.unit_price !== null) {
      const key = usageBucketKey(row);
      const pricing = pricingByBucket.get(key) ?? {};
      pricing[row.dimension as BillingDimension] = row.unit_price;
      pricingByBucket.set(key, pricing);
    }
  }
  for (const [key, pricing] of pricingByBucket) {
    const record = byBucket.get(key);
    if (record) record.cost = pricing;
  }

  for (const row of requests) ensureRecord(row).requests = row.requests;

  return [...byBucket.values()].sort((a, b) => a.hour.localeCompare(b.hour));
};

class SqlSearchUsageRepo implements SearchUsageRepo {
  constructor(private db: SqlDatabase) {}

  async record(args: { provider: SearchUsageRecord['provider']; keyId: string; action: SearchUsageRecord['action']; hour: string; requests: number }): Promise<void> {
    const validProvider = assertWebSearchProviderName(args.provider);
    await this.db
      .prepare(
        `INSERT INTO search_usage (provider, key_id, action, hour, requests) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (provider, key_id, action, hour) DO UPDATE SET
           requests = requests + excluded.requests`,
      )
      .bind(validProvider, args.keyId, args.action, args.hour, args.requests)
      .run();
  }

  async query(opts: { provider?: SearchUsageRecord['provider']; keyId?: string; action?: SearchUsageRecord['action']; start: string; end: string }): Promise<SearchUsageRecord[]> {
    const filters = ['hour >= ?', 'hour < ?'];
    const binds: unknown[] = [opts.start, opts.end];
    if (opts.provider) {
      const validProvider = assertWebSearchProviderName(opts.provider);
      filters.unshift('provider = ?');
      binds.unshift(validProvider);
    }
    if (opts.keyId) {
      filters.push('key_id = ?');
      binds.push(opts.keyId);
    }
    if (opts.action) {
      filters.push('action = ?');
      binds.push(opts.action);
    }

    const { results } = await this.db
      .prepare(`SELECT provider, key_id, action, hour, requests FROM search_usage WHERE ${filters.join(' AND ')} ORDER BY hour`)
      .bind(...binds)
      .all<{
      provider: string;
      key_id: string;
      action: string;
      hour: string;
      requests: number;
    }>();
    return results.map(toSearchUsageRecord);
  }

  async listAll(): Promise<SearchUsageRecord[]> {
    const { results } = await this.db.prepare('SELECT provider, key_id, action, hour, requests FROM search_usage ORDER BY hour').all<{
      provider: string;
      key_id: string;
      action: string;
      hour: string;
      requests: number;
    }>();
    return results.map(toSearchUsageRecord);
  }

  async set(record: SearchUsageRecord): Promise<void> {
    const provider = assertWebSearchProviderName(record.provider);
    await this.db
      .prepare(
        `INSERT INTO search_usage (provider, key_id, action, hour, requests) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (provider, key_id, action, hour) DO UPDATE SET
           requests = excluded.requests`,
      )
      .bind(provider, record.keyId, record.action, record.hour, record.requests)
      .run();
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM search_usage').run();
  }
}

class SqlPerformanceRepo implements PerformanceRepo {
  constructor(private db: SqlDatabase) {}

  async recordLatency(sample: PerformanceLatencySample): Promise<void> {
    const durationMs = Math.max(0, Math.round(sample.durationMs));
    const bucket = latencyBucketForMs(durationMs);
    await runStatements(this.db, [this.addSummaryStatement(sample, 1, 0, durationMs), this.addBucketStatement(sample, bucket.lowerMs, bucket.upperMs, 1)]);
  }

  async recordError(sample: PerformanceErrorSample): Promise<void> {
    await this.addSummaryStatement(sample, 0, 1, 0).run();
  }

  async query(opts: { keyId?: string; metricScope?: PerformanceMetricScope; start: string; end: string }): Promise<PerformanceTelemetryRecord[]> {
    const filters = ['hour >= ?', 'hour < ?'];
    const binds: unknown[] = [opts.start, opts.end];
    if (opts.keyId) {
      filters.push('key_id = ?');
      binds.push(opts.keyId);
    }
    if (opts.metricScope) {
      filters.push('metric_scope = ?');
      binds.push(opts.metricScope);
    }
    return await this.queryWhere(filters.join(' AND '), binds);
  }

  async listAll(): Promise<PerformanceTelemetryRecord[]> {
    return await this.queryWhere('1 = 1', []);
  }

  async set(record: PerformanceTelemetryRecord): Promise<void> {
    await runStatements(this.db, [
      this.setSummaryStatement(record),
      this.deleteBucketsStatement(record),
      ...record.buckets.map(bucket => this.setBucketStatement(record, bucket.lowerMs, bucket.upperMs, bucket.count)),
    ]);
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM performance_latency_buckets').run();
    await this.db.prepare('DELETE FROM performance_summary').run();
  }

  private async queryWhere(where: string, binds: unknown[]): Promise<PerformanceTelemetryRecord[]> {
    const records = new Map<string, PerformanceTelemetryRecord>();

    const { results: summaries } = await this.db
      .prepare(
        `SELECT hour, metric_scope, key_id, model, upstream, model_key, source_api, target_api, stream, runtime_location, requests, errors, total_ms_sum
         FROM performance_summary WHERE ${where} ORDER BY hour`,
      )
      .bind(...binds)
      .all<PerformanceSummaryRow>();
    for (const row of summaries) {
      const dimensions = performanceDimensionsFromRow(row);
      records.set(performanceRecordKey(dimensions), {
        ...dimensions,
        requests: row.requests,
        errors: row.errors,
        totalMsSum: row.total_ms_sum,
        buckets: [],
      });
    }

    const { results: buckets } = await this.db
      .prepare(
        `SELECT hour, metric_scope, key_id, model, upstream, model_key, source_api, target_api, stream, runtime_location, lower_ms, upper_ms, count
         FROM performance_latency_buckets WHERE ${where} ORDER BY hour, upper_ms`,
      )
      .bind(...binds)
      .all<PerformanceBucketRow>();
    for (const row of buckets) {
      const dimensions = performanceDimensionsFromRow(row);
      const key = performanceRecordKey(dimensions);
      let record = records.get(key);
      if (!record) {
        record = {
          ...dimensions,
          requests: 0,
          errors: 0,
          totalMsSum: 0,
          buckets: [],
        };
        records.set(key, record);
      }
      record.buckets.push({
        lowerMs: row.lower_ms,
        upperMs: row.upper_ms,
        count: row.count,
      });
    }

    return [...records.values()].sort(comparePerformanceTelemetryRecords);
  }

  private addSummaryStatement(sample: PerformanceDimensions, requests: number, errors: number, totalMsSum: number): SqlPreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO performance_summary (hour, metric_scope, key_id, model, upstream, model_key, source_api, target_api, stream, runtime_location, requests, errors, total_ms_sum)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET
           requests = requests + excluded.requests,
           errors = errors + excluded.errors,
           total_ms_sum = total_ms_sum + excluded.total_ms_sum`,
      )
      .bind(
        sample.hour,
        sample.metricScope,
        sample.keyId,
        sample.model,
        sample.upstream,
        sample.modelKey,
        sample.sourceApi,
        sample.targetApi,
        sample.stream ? 1 : 0,
        sample.runtimeLocation,
        requests,
        errors,
        totalMsSum,
      );
  }

  private setSummaryStatement(record: PerformanceTelemetryRecord): SqlPreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO performance_summary (hour, metric_scope, key_id, model, upstream, model_key, source_api, target_api, stream, runtime_location, requests, errors, total_ms_sum)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET
           requests = excluded.requests,
           errors = excluded.errors,
           total_ms_sum = excluded.total_ms_sum`,
      )
      .bind(
        record.hour,
        record.metricScope,
        record.keyId,
        record.model,
        record.upstream,
        record.modelKey,
        record.sourceApi,
        record.targetApi,
        record.stream ? 1 : 0,
        record.runtimeLocation,
        record.requests,
        record.errors,
        record.totalMsSum,
      );
  }

  private deleteBucketsStatement(record: PerformanceDimensions): SqlPreparedStatement {
    return this.db
      .prepare(
        `DELETE FROM performance_latency_buckets
         WHERE hour = ? AND metric_scope = ? AND key_id = ? AND model = ? AND upstream IS ? AND model_key = ? AND source_api = ? AND target_api = ? AND stream = ? AND runtime_location = ?`,
      )
      .bind(...performanceDimensionBinds(record));
  }

  private addBucketStatement(sample: PerformanceDimensions, lowerMs: number, upperMs: number, count: number): SqlPreparedStatement {
    return this.bucketStatement(sample, lowerMs, upperMs, count, 'add');
  }

  private setBucketStatement(sample: PerformanceDimensions, lowerMs: number, upperMs: number, count: number): SqlPreparedStatement {
    return this.bucketStatement(sample, lowerMs, upperMs, count, 'set');
  }

  private bucketStatement(sample: PerformanceDimensions, lowerMs: number, upperMs: number, count: number, mode: 'add' | 'set'): SqlPreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO performance_latency_buckets (hour, metric_scope, key_id, model, upstream, model_key, source_api, target_api, stream, runtime_location, lower_ms, upper_ms, count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET
           count = ${mode === 'add' ? 'count + excluded.count' : 'excluded.count'}`,
      )
      .bind(
        sample.hour,
        sample.metricScope,
        sample.keyId,
        sample.model,
        sample.upstream,
        sample.modelKey,
        sample.sourceApi,
        sample.targetApi,
        sample.stream ? 1 : 0,
        sample.runtimeLocation,
        lowerMs,
        upperMs,
        count,
      );
  }
}

type PerformanceDimensionRow = {
  hour: string;
  metric_scope: string;
  key_id: string;
  model: string;
  upstream: string | null;
  model_key: string;
  source_api: string;
  target_api: string;
  stream: number;
  runtime_location: string;
};

interface PerformanceSummaryRow extends PerformanceDimensionRow {
  requests: number;
  errors: number;
  total_ms_sum: number;
}

interface PerformanceBucketRow extends PerformanceDimensionRow {
  lower_ms: number;
  upper_ms: number;
  count: number;
}

function performanceDimensionsFromRow(row: PerformanceDimensionRow): PerformanceDimensions {
  return {
    hour: row.hour,
    metricScope: row.metric_scope as PerformanceMetricScope,
    keyId: row.key_id,
    model: row.model,
    upstream: row.upstream ?? null,
    modelKey: row.model_key,
    sourceApi: row.source_api as PerformanceTelemetryRecord['sourceApi'],
    targetApi: row.target_api as PerformanceTelemetryRecord['targetApi'],
    stream: row.stream === 1,
    runtimeLocation: row.runtime_location,
  };
}

function performanceRecordKey(record: PerformanceDimensions): string {
  return [record.hour, record.metricScope, record.keyId, record.model, record.upstream, record.modelKey, record.sourceApi, record.targetApi, record.stream ? '1' : '0', record.runtimeLocation].join(
    '\0',
  );
}

function performanceDimensionBinds(record: PerformanceDimensions): unknown[] {
  return [record.hour, record.metricScope, record.keyId, record.model, record.upstream, record.modelKey, record.sourceApi, record.targetApi, record.stream ? 1 : 0, record.runtimeLocation];
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

function toSearchUsageRecord(row: { provider: string; key_id: string; action: string; hour: string; requests: number }): SearchUsageRecord {
  if (row.action !== 'search' && row.action !== 'fetch_page') {
    throw new TypeError(`Invalid search usage action: ${row.action}`);
  }
  return {
    provider: assertWebSearchProviderName(row.provider),
    keyId: row.key_id,
    action: row.action,
    hour: row.hour,
    requests: row.requests,
  };
}

class SqlCacheRepo implements CacheRepo {
  constructor(private db: SqlDatabase) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db.prepare('SELECT value FROM config WHERE key = ?').bind(key).first<{ value: string }>();
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(key, value).run();
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare('DELETE FROM config WHERE key = ?').bind(key).run();
  }

  async deletePrefix(prefix: string): Promise<void> {
    await this.db.prepare('DELETE FROM config WHERE key >= ? AND key < ?').bind(prefix, `${prefix}\uffff`).run();
  }
}

const RESPONSES_ITEM_COLUMNS = 'id, api_key_id, upstream_id, upstream_item_id, item_type, origin, payload_json, content_hash, encrypted_content_hash, created_at, refreshed_at';
const RESPONSES_ITEM_ID_SCOPE_SQL = "COALESCE(api_key_id, '') = COALESCE(?, '')";

class SqlResponsesItemsRepo implements ResponsesItemsRepo {
  constructor(private db: SqlDatabase) {}

  async lookupMany(apiKeyId: string | null, ids: readonly string[]): Promise<StoredResponsesItem[]> {
    const rows = await this.lookupByColumn(apiKeyId, 'id', ids);
    const order = new Map([...new Set(ids)].map((id, index) => [id, index]));
    return rows.toSorted((a, b) => order.get(a.id)! - order.get(b.id)!);
  }

  async lookupManyByEncryptedContentHash(apiKeyId: string | null, hashes: readonly string[]): Promise<StoredResponsesItem[]> {
    return await this.lookupByColumn(apiKeyId, 'encrypted_content_hash', hashes);
  }

  async lookupManyByContentHash(apiKeyId: string | null, hashes: readonly string[]): Promise<StoredResponsesItem[]> {
    return await this.lookupByColumn(apiKeyId, 'content_hash', hashes);
  }

  // D1 caps bound parameters at 100 per query (node:sqlite's default cap is
  // 32766, well above this). A single Responses request can echo back more
  // stored items than D1's cap — long agentic sessions resubmit every prior
  // reasoning/compaction item each turn — so chunk the IN-list well under
  // the tightest backend (the `api_key_id` bind shares the budget) and union
  // the results.
  private async lookupByColumn(apiKeyId: string | null, column: 'id' | 'content_hash' | 'encrypted_content_hash', values: readonly string[]): Promise<StoredResponsesItem[]> {
    const unique = [...new Set(values)];
    if (unique.length === 0) return [];

    const CHUNK = 90;
    const chunks: string[][] = [];
    for (let i = 0; i < unique.length; i += CHUNK) chunks.push(unique.slice(i, i + CHUNK));

    const perChunk = await Promise.all(chunks.map(async chunk => {
      const placeholders = chunk.map(() => '?').join(', ');
      const orderSql = column === 'id' ? '' : ' ORDER BY refreshed_at DESC, created_at DESC, id ASC';
      const scopeSql = column === 'id' ? RESPONSES_ITEM_ID_SCOPE_SQL : 'api_key_id IS ?';
      const { results } = await this.db
        .prepare(`SELECT ${RESPONSES_ITEM_COLUMNS} FROM responses_items WHERE ${scopeSql} AND ${column} IN (${placeholders})${orderSql}`)
        .bind(apiKeyId, ...chunk)
        .all<ResponsesItemRow>();
      return await Promise.all(results.map(toStoredResponsesItem));
    }));
    return perChunk.flat();
  }

  async insertMany(items: readonly StoredResponsesItem[]): Promise<void> {
    const statements = await Promise.all(items.map(async item => {
      const payload = await serializeStoredResponsesPayload(item.id, item.apiKeyId, item.createdAt, item.payload);
      // One INSERT per `(id, api_key_id)`. Stream pipelines call insertMany
      // exactly once per stored id at the carrier's finalizing frame; the
      // wrap's idMapper memoizes so reattempts within one stream are
      // impossible. Cross-session collisions of the random body are
      // effectively impossible (~2^-128) and treated as no-op if they ever
      // happen.
      return this.db
        .prepare(
          `INSERT INTO responses_items (${RESPONSES_ITEM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id, COALESCE(api_key_id, '')) DO NOTHING`,
        )
        .bind(item.id, item.apiKeyId, item.upstreamId, item.upstreamItemId, item.itemType, item.origin, payload, item.contentHash, item.encryptedContentHash, item.createdAt, item.refreshedAt);
    }));
    await runStatements(this.db, statements);
  }

  async fillPayloads(items: readonly StoredResponsesItem[]): Promise<number> {
    const statements = await Promise.all(items.flatMap(item => {
      if (item.payload === null) return [];
      return [serializeStoredResponsesPayload(item.id, item.apiKeyId, item.createdAt, item.payload).then(payload =>
        this.db
          .prepare(
            `UPDATE responses_items
             SET payload_json = ?, content_hash = ?, encrypted_content_hash = ?, created_at = ?, refreshed_at = ?
             WHERE ${RESPONSES_ITEM_ID_SCOPE_SQL} AND id = ? AND payload_json IS NULL`,
          )
          .bind(payload, item.contentHash, item.encryptedContentHash, item.createdAt, item.refreshedAt, item.apiKeyId, item.id))];
    }));
    const results = await runStatements(this.db, statements);
    return results.reduce((sum, result) => sum + ((result.meta.changes as number | undefined) ?? 0), 0);
  }

  async refreshMany(apiKeyId: string | null, ids: readonly string[], refreshedAt: number): Promise<number> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return 0;

    const CHUNK = 88;
    const chunks: string[][] = [];
    for (let i = 0; i < unique.length; i += CHUNK) chunks.push(unique.slice(i, i + CHUNK));
    const results = await Promise.all(chunks.map(async chunk => {
      const placeholders = chunk.map(() => '?').join(', ');
      return await this.db
        .prepare(`UPDATE responses_items SET refreshed_at = ? WHERE ${RESPONSES_ITEM_ID_SCOPE_SQL} AND id IN (${placeholders}) AND refreshed_at < ?`)
        .bind(refreshedAt, apiKeyId, ...chunk, refreshedAt - RESPONSES_REFRESH_DEBOUNCE_MS)
        .run();
    }));
    return results.reduce((sum, result) => sum + ((result.meta.changes as number | undefined) ?? 0), 0);
  }

  async clearPayloadOlderThan(createdBefore: number): Promise<number> {
    const result = await this.db.prepare('UPDATE responses_items SET payload_json = NULL WHERE payload_json IS NOT NULL AND created_at < ?').bind(createdBefore).run();
    return (result.meta.changes as number | undefined) ?? 0;
  }

  async deleteOlderThan(refreshedBefore: number): Promise<number> {
    const result = await this.db.prepare('DELETE FROM responses_items WHERE refreshed_at < ?').bind(refreshedBefore).run();
    return (result.meta.changes as number | undefined) ?? 0;
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM responses_items').run();
    await deleteAllResponsesItemPayloadFiles();
  }
}

interface ResponsesItemRow {
  id: string;
  api_key_id: string | null;
  upstream_id: string | null;
  upstream_item_id: string | null;
  item_type: string;
  origin: StoredResponsesItem['origin'];
  payload_json: string | null;
  content_hash: string | null;
  encrypted_content_hash: string | null;
  created_at: number;
  refreshed_at: number;
}

const toStoredResponsesItem = async (row: ResponsesItemRow): Promise<StoredResponsesItem> => ({
  id: row.id,
  apiKeyId: row.api_key_id,
  upstreamId: row.upstream_id,
  upstreamItemId: row.upstream_item_id,
  itemType: row.item_type,
  origin: row.origin,
  payload: await parseStoredResponsesPayload(row.id, row.payload_json),
  contentHash: row.content_hash,
  encryptedContentHash: row.encrypted_content_hash,
  createdAt: row.created_at,
  refreshedAt: row.refreshed_at,
});

class SqlResponsesSnapshotsRepo implements ResponsesSnapshotsRepo {
  constructor(private db: SqlDatabase) {}

  async lookup(apiKeyId: string | null, id: string): Promise<StoredResponsesSnapshot | null> {
    const row = await this.db
      .prepare('SELECT id, api_key_id, item_ids_json, created_at, refreshed_at FROM responses_snapshots WHERE id = ? AND COALESCE(api_key_id, \'\') = COALESCE(?, \'\')')
      .bind(id, apiKeyId)
      .first<ResponsesSnapshotRow>();
    return row ? toStoredResponsesSnapshot(row) : null;
  }

  async insert(snapshot: StoredResponsesSnapshot): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO responses_snapshots (id, api_key_id, item_ids_json, created_at, refreshed_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id, COALESCE(api_key_id, '')) DO UPDATE SET item_ids_json = excluded.item_ids_json, refreshed_at = excluded.refreshed_at`,
      )
      .bind(snapshot.id, snapshot.apiKeyId, JSON.stringify(snapshot.itemIds), snapshot.createdAt, snapshot.refreshedAt)
      .run();
  }

  async refresh(apiKeyId: string | null, id: string, refreshedAt: number): Promise<boolean> {
    const result = await this.db
      .prepare('UPDATE responses_snapshots SET refreshed_at = ? WHERE id = ? AND COALESCE(api_key_id, \'\') = COALESCE(?, \'\') AND refreshed_at < ?')
      .bind(refreshedAt, id, apiKeyId, refreshedAt - RESPONSES_REFRESH_DEBOUNCE_MS)
      .run();
    return ((result.meta.changes as number | undefined) ?? 0) > 0;
  }

  async deleteOlderThan(refreshedBefore: number): Promise<number> {
    const result = await this.db.prepare('DELETE FROM responses_snapshots WHERE refreshed_at < ?').bind(refreshedBefore).run();
    return (result.meta.changes as number | undefined) ?? 0;
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM responses_snapshots').run();
  }
}

interface ResponsesSnapshotRow {
  id: string;
  api_key_id: string | null;
  item_ids_json: string;
  created_at: number;
  refreshed_at: number;
}

const toStoredResponsesSnapshot = (row: ResponsesSnapshotRow): StoredResponsesSnapshot => {
  const parsed: unknown = JSON.parse(row.item_ids_json);
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
    throw new Error(`Invalid responses_snapshots.item_ids_json for id=${row.id}`);
  }
  return {
    id: row.id,
    apiKeyId: row.api_key_id,
    itemIds: parsed,
    createdAt: row.created_at,
    refreshedAt: row.refreshed_at,
  };
};

class SqlSearchConfigRepo implements SearchConfigRepo {
  constructor(private db: SqlDatabase) {}

  async get(): Promise<unknown | null> {
    const row = await this.db.prepare('SELECT value FROM config WHERE key = ?').bind(SEARCH_CONFIG_KEY).first<{ value: string }>();

    if (!row?.value) {
      return null;
    }

    // Surface stored-JSON corruption — silently returning null would hide a
    // corrupt config row from operators behind the load helper's default
    // fallback.
    try {
      return JSON.parse(row.value);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Malformed search_config JSON in repo storage: ${message}`, { cause });
    }
  }

  async save(config: unknown): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO config (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(SEARCH_CONFIG_KEY, serializeStoredConfig(config))
      .run();
  }
}

class SqlUpstreamRepo implements UpstreamRepo {
  constructor(private db: SqlDatabase) {}

  async list(): Promise<UpstreamRecord[]> {
    const { results } = await this.db
      .prepare('SELECT id, provider, name, enabled, sort_order, created_at, updated_at, config_json, state_json, flag_overrides, disabled_public_model_ids FROM upstreams ORDER BY sort_order, created_at')
      .all<UpstreamRow>();
    return results.map(toUpstreamRecord);
  }

  async getById(id: string): Promise<UpstreamRecord | null> {
    const row = await this.db
      .prepare('SELECT id, provider, name, enabled, sort_order, created_at, updated_at, config_json, state_json, flag_overrides, disabled_public_model_ids FROM upstreams WHERE id = ?')
      .bind(id)
      .first<UpstreamRow>();
    return row ? toUpstreamRecord(row) : null;
  }

  async save(upstream: UpstreamRecord): Promise<void> {
    // created_at is deliberately not in the ON CONFLICT update list: the row's first INSERT
    // wins, and re-saves preserve that timestamp regardless of what the caller passes.
    await this.db
      .prepare(
        `INSERT INTO upstreams (id, provider, name, enabled, sort_order, created_at, updated_at, config_json, state_json, flag_overrides, disabled_public_model_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           provider = excluded.provider,
           name = excluded.name,
           enabled = excluded.enabled,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at,
           config_json = excluded.config_json,
           state_json = excluded.state_json,
           flag_overrides = excluded.flag_overrides,
           disabled_public_model_ids = excluded.disabled_public_model_ids`,
      )
      .bind(
        upstream.id,
        upstream.provider,
        upstream.name,
        upstream.enabled ? 1 : 0,
        upstream.sortOrder,
        upstream.createdAt,
        upstream.updatedAt,
        serializeStoredConfig(upstream.config),
        serializeStoredState(upstream.state),
        JSON.stringify(normalizeFlagOverrides(upstream.flagOverrides)),
        JSON.stringify(normalizeDisabledPublicModelIds(upstream.disabledPublicModelIds)),
      )
      .run();
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM upstreams WHERE id = ?').bind(id).run();
    return ((result.meta.changes as number) ?? 0) > 0;
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM upstreams').run();
  }

  // `IS` (not `=`) so NULL on either side compares correctly — a row whose
  // state_json is SQL NULL still matches when the caller passes
  // expectedState: null. The serialized form here must equal what save()
  // wrote for the predicate to hold on the back-to-back write path.
  async saveState(id: string, newState: unknown, options: { expectedState: unknown }): Promise<{ updated: boolean }> {
    const result = await this.db
      .prepare('UPDATE upstreams SET state_json = ? WHERE id = ? AND state_json IS ?')
      .bind(serializeStoredState(newState), id, serializeStoredState(options.expectedState))
      .run();
    return { updated: ((result.meta.changes as number | undefined) ?? 0) > 0 };
  }
}

interface UpstreamRow {
  id: string;
  provider: string;
  name: string;
  enabled: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  config_json: string;
  state_json: string | null;
  flag_overrides: string;
  disabled_public_model_ids: string;
}

function toUpstreamRecord(row: UpstreamRow): UpstreamRecord {
  let config: unknown;
  try {
    config = JSON.parse(row.config_json) as unknown;
  } catch {
    throw new Error(`Malformed upstream config JSON for ${row.id}`);
  }
  let state: unknown = null;
  if (row.state_json !== null) {
    try {
      state = JSON.parse(row.state_json) as unknown;
    } catch {
      throw new Error(`Malformed upstream state JSON for ${row.id}`);
    }
  }

  return {
    id: row.id,
    provider: assertUpstreamProviderKind(row.provider),
    name: row.name,
    enabled: row.enabled !== 0,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    config,
    state,
    flagOverrides: parseFlagOverrides(row.id, row.flag_overrides),
    disabledPublicModelIds: parseDisabledPublicModelIds(row.id, row.disabled_public_model_ids),
  };
}

const assertUpstreamProviderKind = (provider: string): UpstreamProviderKind => {
  if (provider === 'copilot' || provider === 'custom' || provider === 'azure' || provider === 'codex') return provider;
  throw new TypeError(`Invalid upstream provider kind: ${provider}`);
};

const parseFlagOverrides = (id: string, json: string): Record<string, boolean> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new Error(`Malformed upstream flag_overrides JSON for ${id}`, { cause });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const got = Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed;
    throw new Error(`Upstream ${id} flag_overrides must be a JSON object, got ${got}`);
  }
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'boolean') {
      throw new Error(`Upstream ${id} flag_overrides[${JSON.stringify(k)}] must be a boolean, got ${typeof v}`);
    }
    out[k] = v;
  }
  return normalizeFlagOverrides(out);
};

const parseDisabledPublicModelIds = (id: string, json: string): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new Error(`Malformed upstream disabled_public_model_ids JSON for ${id}`, { cause });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Upstream ${id} disabled_public_model_ids must be a JSON array, got ${parsed === null ? 'null' : typeof parsed}`);
  }
  for (const entry of parsed) {
    if (typeof entry !== 'string') {
      throw new Error(`Upstream ${id} disabled_public_model_ids entries must be strings, got ${typeof entry}`);
    }
  }
  return normalizeDisabledPublicModelIds(parsed as string[]);
};

export class SqlRepo implements Repo {
  apiKeys: ApiKeyRepo;
  usage: UsageRepo;
  searchUsage: SearchUsageRepo;
  performance: PerformanceRepo;
  cache: CacheRepo;
  searchConfig: SearchConfigRepo;
  upstreams: UpstreamRepo;
  responsesItems: ResponsesItemsRepo;
  responsesSnapshots: ResponsesSnapshotsRepo;

  constructor(db: SqlDatabase) {
    this.apiKeys = new SqlApiKeyRepo(db);
    this.usage = new SqlUsageRepo(db);
    this.searchUsage = new SqlSearchUsageRepo(db);
    this.performance = new SqlPerformanceRepo(db);
    this.cache = new SqlCacheRepo(db);
    this.searchConfig = new SqlSearchConfigRepo(db);
    this.upstreams = new SqlUpstreamRepo(db);
    this.responsesItems = new SqlResponsesItemsRepo(db);
    this.responsesSnapshots = new SqlResponsesSnapshotsRepo(db);
  }
}
