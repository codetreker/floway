// Per-upstream model list cache. Each upstream adapter gets its own /models
// cache key; provider code decides how those upstream adapters map to accounts
// or configured custom providers.
//
// Tiers:
//   L1 in-process (120s)            — avoids repeated repo reads on hot isolates
//   L2 repo-backed soft expiry      — refresh attempts after 600s
//   L2 repo-backed hard expiry      — configured model-load failures may reuse
//                                     stale data for up to 2h so transient
//                                     provider failures do not empty listings

import { getRepo } from '../../repo/index.ts';
import type { Upstream } from '../../shared/upstream/types.ts';

export interface CachedModelInfo {
  id: string;
  object?: string;
  name?: string;
  version?: string;
  owned_by?: string;
  created?: number;
  display_name?: string;
  created_at?: string;
  description?: string;
  supported_endpoints?: string[];
  capabilities?: {
    family?: string;
    type?: string;
    limits?: {
      max_context_window_tokens?: number;
      max_non_streaming_output_tokens?: number;
      max_prompt_tokens?: number;
      max_output_tokens?: number;
    };
    supports?: {
      tool_calls?: boolean;
      parallel_tool_calls?: boolean;
      streaming?: boolean;
      vision?: boolean;
      adaptive_thinking?: boolean;
      reasoning_effort?: string[];
    };
  };
  supports_generation?: boolean;
  model_picker_enabled?: boolean;
  billing?: {
    is_premium?: boolean;
    multiplier?: number;
    restricted_to?: string[];
  };
  policy?: {
    state?: string;
    terms?: string;
  };
}

export interface CachedModelsResponse<TModel extends CachedModelInfo = CachedModelInfo> {
  object: string;
  data: TModel[];
}

export interface LoadModelsOptions {
  canReuseStaleOnModelLoadStatus?: (status: number) => boolean;
}

interface ModelsCacheEntry {
  fetchedAt: number;
  hardExpiresAt: number;
  data: CachedModelsResponse;
}

export interface ModelsLoadSuccess {
  type: 'models';
  data: CachedModelsResponse;
  stale: boolean;
}

export interface ModelsLoadFailure {
  type: 'error';
  error: unknown;
}

export type ModelsLoadResult = ModelsLoadSuccess | ModelsLoadFailure;

export class ModelsFetchError extends Error {
  constructor(readonly status: number, readonly body: string, readonly headers: Headers) {
    super(`Models fetch failed: ${status} ${body}`);
    this.name = 'ModelsFetchError';
  }
}

export class ModelsRequestError extends Error {
  constructor(cause: unknown) {
    super('Upstream model listing failed', { cause });
    this.name = 'ModelsRequestError';
  }
}

const IN_PROCESS_TTL_MS = 120_000;
const SOFT_TTL_MS = 600_000;
const HARD_TTL_MS = 2 * 60 * 60 * 1000;
const MODELS_CACHE_KEY_PREFIX = 'models_cache_v2';

const inProcessCache = new Map<
  string,
  {
    entry: ModelsCacheEntry;
    cachedAt: number;
  }
>();

export const clearModelsCache = (): void => {
  inProcessCache.clear();
};

const cacheKeyForUpstream = (upstream: Upstream): string => `${MODELS_CACHE_KEY_PREFIX}:${upstream.id}`;

// Drop both L1 and L2 cache entries for a single upstream id. Use when an
// upstream's config (base URL, bearer, supported endpoints) changes — the
// stored model list belongs to the old credentials and would otherwise
// linger up to HARD_TTL_MS.
export const invalidateUpstreamModels = async (upstreamId: string): Promise<void> => {
  const cacheKey = `${MODELS_CACHE_KEY_PREFIX}:${upstreamId}`;
  inProcessCache.delete(cacheKey);
  try {
    await getRepo().cache.delete(cacheKey);
  } catch {
    // Best-effort; the in-process drop alone still forces a refresh on this isolate.
  }
};

const isSoftFresh = (entry: ModelsCacheEntry, now: number): boolean => now - entry.fetchedAt < SOFT_TTL_MS;

const isHardFresh = (entry: ModelsCacheEntry, now: number): boolean => entry.hardExpiresAt > now;

const isCacheEntry = (value: unknown): value is ModelsCacheEntry => {
  const entry = value as ModelsCacheEntry;
  return typeof entry?.fetchedAt === 'number' && typeof entry.hardExpiresAt === 'number' && isModelsResponse(entry.data);
};

const isModelsResponse = (value: unknown): value is CachedModelsResponse => {
  const response = value as CachedModelsResponse;
  return typeof response?.object === 'string' && Array.isArray(response.data) && response.data.every(model => typeof model?.id === 'string');
};

const readRepoCache = async (cacheKey: string): Promise<ModelsCacheEntry | null> => {
  try {
    const raw = await getRepo().cache.get(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isCacheEntry(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const writeRepoCache = async (cacheKey: string, entry: ModelsCacheEntry): Promise<void> => {
  try {
    await getRepo().cache.set(cacheKey, JSON.stringify(entry));
  } catch {
    // Repo cache is an optimization; fetch result is still usable without persisting it.
  }
};

const canReuseStaleForStatus = (status: number, options: LoadModelsOptions): boolean => (options.canReuseStaleOnModelLoadStatus ? options.canReuseStaleOnModelLoadStatus(status) : status === 429);

export const canReuseStaleForModelsLoadError = (error: unknown, options: LoadModelsOptions = {}): boolean => {
  if (error instanceof ModelsFetchError) {
    return canReuseStaleForStatus(error.status, options);
  }
  return false;
};

const fetchUpstreamModels = async (upstream: Upstream): Promise<CachedModelsResponse> => {
  let resp: Response;
  try {
    resp = await upstream.fetch('models', { method: 'GET' });
  } catch (error) {
    throw new ModelsRequestError(error);
  }

  if (!resp.ok) {
    throw new ModelsFetchError(resp.status, await resp.text(), new Headers(resp.headers));
  }

  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    throw new Error('Invalid upstream /models response');
  }
  if (!isModelsResponse(data)) {
    throw new Error('Invalid upstream /models response');
  }
  return data;
};

/**
 * Load models for an upstream with discriminated success/failure result.
 *
 * Used by provider model listing so it can classify transient upstream
 * failures: configured model-load errors may reuse stale cache, while everything
 * else propagates to the caller.
 */
export const loadModels = async (upstream: Upstream, options: LoadModelsOptions = {}): Promise<ModelsLoadResult> => {
  const now = Date.now();
  const cacheKey = cacheKeyForUpstream(upstream);
  const cached = inProcessCache.get(cacheKey);

  if (cached && now - cached.cachedAt < IN_PROCESS_TTL_MS && isHardFresh(cached.entry, now)) {
    return {
      type: 'models',
      data: cached.entry.data,
      stale: !isSoftFresh(cached.entry, now),
    };
  }

  const repoEntry = await readRepoCache(cacheKey);
  if (repoEntry && isSoftFresh(repoEntry, now)) {
    inProcessCache.set(cacheKey, { entry: repoEntry, cachedAt: now });
    return { type: 'models', data: repoEntry.data, stale: false };
  }

  try {
    const data = await fetchUpstreamModels(upstream);
    const entry = {
      fetchedAt: now,
      hardExpiresAt: now + HARD_TTL_MS,
      data,
    } satisfies ModelsCacheEntry;
    inProcessCache.set(cacheKey, { entry, cachedAt: now });
    await writeRepoCache(cacheKey, entry);
    return { type: 'models', data, stale: false };
  } catch (error) {
    if (repoEntry && isHardFresh(repoEntry, now) && canReuseStaleForModelsLoadError(error, options)) {
      inProcessCache.set(cacheKey, { entry: repoEntry, cachedAt: now });
      return { type: 'models', data: repoEntry.data, stale: true };
    }

    if (cached && isHardFresh(cached.entry, now) && canReuseStaleForModelsLoadError(error, options)) {
      return { type: 'models', data: cached.entry.data, stale: true };
    }

    return { type: 'error', error };
  }
};
