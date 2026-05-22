// Provider model-listing store. Two storage tiers — in-process memo (L1) for
// hot-isolate reads, repo cache (L2) for cross-isolate persistence. Each
// provider owns when and how to use these; this module has no policy.
//
// Memo keys are caller-chosen strings (providers pass `upstream.id` bare so
// `invalidateModelsStore(upstream.id)` clears both tiers). L2 row keys are
// prefixed internally so the repo cache namespace stays isolated.

import { getRepo } from '../../repo/index.ts';

const CACHE_KEY_PREFIX = 'models_store:';

interface MemoEntry {
  value: Promise<unknown>;
  expiresAt: number;
}

const memos = new Map<string, MemoEntry>();

export const clearModelsStore = (): void => {
  memos.clear();
};

export const inProcessMemo = <T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> => {
  const now = Date.now();
  const existing = memos.get(key);
  if (existing && existing.expiresAt > now) {
    return existing.value as Promise<T>;
  }

  const promise = fn();
  memos.set(key, { value: promise, expiresAt: now + ttlMs });
  // Delete only if the entry is still ours; a delayed rejection must not clobber a later successful retry.
  promise.catch(() => {
    if (memos.get(key)?.value === promise) memos.delete(key);
  });
  return promise;
};

const cacheKey = (upstreamId: string): string => `${CACHE_KEY_PREFIX}${upstreamId}`;

export const readModelsStore = async <T>(upstreamId: string): Promise<T | null> => {
  try {
    const raw = await getRepo().cache.get(cacheKey(upstreamId));
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export const writeModelsStore = async <T>(upstreamId: string, value: T): Promise<void> => {
  try {
    await getRepo().cache.set(cacheKey(upstreamId), JSON.stringify(value));
  } catch {
    // Best-effort persistence; loss only means the next isolate re-fetches.
  }
};

export const invalidateModelsStore = async (upstreamId: string): Promise<void> => {
  memos.delete(upstreamId);
  try {
    await getRepo().cache.delete(cacheKey(upstreamId));
  } catch {
    // In-process drop alone still forces a refresh on this isolate.
  }
};

export class ProviderModelsUnavailableError extends Error {
  constructor(
    readonly httpResponse: { status: number; headers: Headers; body: string } | null,
    cause?: unknown,
  ) {
    super('Provider model listing failed', cause !== undefined ? { cause } : undefined);
    this.name = 'ProviderModelsUnavailableError';
  }
}

export const isProviderModelsHttpStatus = (error: unknown, status: number): boolean =>
  error instanceof ProviderModelsUnavailableError && error.httpResponse?.status === status;

// Build a Response that mirrors an upstream model-listing HTTP failure for
// real-API consumers that want to passthrough status/headers/body. Returns
// null when there is no captured upstream HTTP frame (e.g. network errors
// or malformed bodies), so callers can decide their own fallback shape.
export const httpResponseToResponse = (httpResponse: ProviderModelsUnavailableError['httpResponse']): Response | null => {
  if (!httpResponse) return null;
  return new Response(httpResponse.body, {
    status: httpResponse.status,
    headers: new Headers(httpResponse.headers),
  });
};
