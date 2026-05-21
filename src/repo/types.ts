import type { HistogramBucket } from '../shared/performance-histogram.ts';
import type { WebSearchProviderName } from '../shared/web-search-providers.ts';

export interface ApiKey {
  id: string;
  name: string;
  key: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface GitHubAccount {
  token: string;
  accountType: string;
  user: {
    login: string;
    avatar_url: string;
    name: string | null;
    id: number;
  };
}

export interface UsageRecord {
  keyId: string;
  model: string;
  upstream: string | null;
  modelKey: string;
  hour: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface TelemetryModelIdentity {
  model: string;
  upstream: string;
  modelKey: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface SearchUsageRecord {
  provider: WebSearchProviderName;
  keyId: string;
  hour: string;
  requests: number;
}

export type PerformanceMetricScope = 'request_total' | 'upstream_success';
export type PerformanceApiName = 'messages' | 'responses' | 'chat-completions' | 'gemini' | 'embeddings';

export interface PerformanceDimensions {
  hour: string;
  metricScope: PerformanceMetricScope;
  keyId: string;
  model: string;
  upstream: string | null;
  modelKey: string;
  sourceApi: PerformanceApiName;
  targetApi: PerformanceApiName;
  stream: boolean;
  runtimeLocation: string;
}

export interface PerformanceLatencySample extends PerformanceDimensions {
  durationMs: number;
}

export interface PerformanceErrorSample extends PerformanceDimensions {}

export interface PerformanceTelemetryRecord extends PerformanceDimensions {
  requests: number;
  errors: number;
  totalMsSum: number;
  buckets: HistogramBucket[];
}

export interface ApiKeyRepo {
  list(): Promise<ApiKey[]>;
  findByRawKey(rawKey: string): Promise<ApiKey | null>;
  getById(id: string): Promise<ApiKey | null>;
  save(key: ApiKey): Promise<void>;
  delete(id: string): Promise<boolean>;
  deleteAll(): Promise<void>;
}

export interface GitHubRepo {
  listAccounts(): Promise<GitHubAccount[]>;
  getAccount(userId: number): Promise<GitHubAccount | null>;
  saveAccount(userId: number, account: GitHubAccount): Promise<void>;
  deleteAccount(userId: number): Promise<void>;
  setOrder(userIds: number[]): Promise<void>;
  deleteAllAccounts(): Promise<void>;
}

export interface UsageRepo {
  record(
    keyId: string,
    model: string,
    upstream: string | null,
    modelKey: string,
    hour: string,
    requests: number,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens?: number,
    cacheCreationTokens?: number,
  ): Promise<void>;
  query(opts: { keyId?: string; start: string; end: string }): Promise<UsageRecord[]>;
  listAll(): Promise<UsageRecord[]>;
  set(record: UsageRecord): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface SearchUsageRepo {
  record(provider: WebSearchProviderName, keyId: string, hour: string, requests: number): Promise<void>;
  query(opts: { provider?: WebSearchProviderName; keyId?: string; start: string; end: string }): Promise<SearchUsageRecord[]>;
  listAll(): Promise<SearchUsageRecord[]>;
  set(record: SearchUsageRecord): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface PerformanceRepo {
  recordLatency(sample: PerformanceLatencySample): Promise<void>;
  recordError(sample: PerformanceErrorSample): Promise<void>;
  query(opts: { keyId?: string; metricScope?: PerformanceMetricScope; start: string; end: string }): Promise<PerformanceTelemetryRecord[]>;
  listAll(): Promise<PerformanceTelemetryRecord[]>;
  set(record: PerformanceTelemetryRecord): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface CacheRepo {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

export interface SearchConfigRepo {
  get(): Promise<unknown | null>;
  save(config: unknown): Promise<void>;
}

// Logical endpoint keys used by the gateway-internal upstream dispatcher.
// `messages_count_tokens` is intentionally a logical key: it is a sub-path of
// `messages` and follows whatever path the admin chose for messages, so the
// UI never exposes it as a separate configurable endpoint.
export type EndpointKey = 'chat_completions' | 'responses' | 'messages' | 'messages_count_tokens' | 'embeddings' | 'models';

export interface UpstreamConfig {
  id: string;
  name: string;
  baseUrl: string;
  bearerToken: string;
  supportedEndpoints: string[];
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  // Behavior flag ids the admin opted into for this upstream. See
  // src/data-plane/providers/fixes.ts for the catalog.
  // Always sorted + deduped at the repo boundary.
  enabledFixes: string[];
  // Optional per-endpoint path overrides. The final URL is `baseUrl + path`
  // with no automatic `/v1` prefixing — admins enter the exact path the
  // upstream serves. `messages_count_tokens` follows `messages` and is not
  // overridable independently.
  pathOverrides?: Partial<Record<Exclude<EndpointKey, 'messages_count_tokens'>, string>>;
}

export interface UpstreamConfigRepo {
  list(): Promise<UpstreamConfig[]>;
  getById(id: string): Promise<UpstreamConfig | null>;
  save(config: UpstreamConfig): Promise<void>;
  delete(id: string): Promise<boolean>;
  deleteAll(): Promise<void>;
}

export interface Repo {
  apiKeys: ApiKeyRepo;
  github: GitHubRepo;
  usage: UsageRepo;
  searchUsage: SearchUsageRepo;
  performance: PerformanceRepo;
  cache: CacheRepo;
  searchConfig: SearchConfigRepo;
  upstreamConfigs: UpstreamConfigRepo;
}
