// Provider model-listing store. Two storage tiers — in-process memo (L1) for
// hot-isolate reads, repo cache (L2) for cross-isolate persistence. Each
// provider owns when and how to use these; this module has no policy.
//
// The same key passed to `inProcessMemo` must be passed to
// `invalidateModelsStore` for invalidation to hit both tiers. L2 row keys
// are prefixed internally so the repo cache namespace stays isolated.

import { getProviderRepo } from './repo.ts';

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
    const raw = await getProviderRepo().cache.get(cacheKey(upstreamId));
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export const writeModelsStore = async <T>(upstreamId: string, value: T): Promise<void> => {
  try {
    await getProviderRepo().cache.set(cacheKey(upstreamId), JSON.stringify(value));
  } catch {
    // Best-effort persistence; loss only means the next isolate re-fetches.
  }
};

export const invalidateModelsStore = async (upstreamId: string): Promise<void> => {
  memos.delete(upstreamId);
  try {
    await getProviderRepo().cache.delete(cacheKey(upstreamId));
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

// Reconstruct a Response from the captured upstream HTTP frame, or null
// when none was captured (e.g. network errors or malformed bodies) — that
// null lets callers choose their own fallback shape.
export const httpResponseToResponse = (httpResponse: ProviderModelsUnavailableError['httpResponse']): Response | null => {
  if (!httpResponse) return null;
  return new Response(httpResponse.body, {
    status: httpResponse.status,
    headers: new Headers(httpResponse.headers),
  });
};

// Shared scaffold for "fetch the upstream's /models, decode JSON, validate
// shape" — error envelope identical across providers (network / JSON-parse
// / shape-invalid ⇒ ProviderModelsUnavailableError(null, cause); non-2xx
// ⇒ status+headers+body).
export const fetchUpstreamModels = async <T>(
  doFetch: () => Promise<Response>,
  parse: (json: unknown) => T | null,
): Promise<T> => {
  let response: Response;
  try {
    response = await doFetch();
  } catch (cause) {
    throw new ProviderModelsUnavailableError(null, cause);
  }
  if (!response.ok) {
    throw new ProviderModelsUnavailableError({
      status: response.status,
      headers: new Headers(response.headers),
      body: await response.text(),
    });
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (cause) {
    throw new ProviderModelsUnavailableError(null, cause);
  }
  const result = parse(parsed);
  if (result === null) {
    throw new ProviderModelsUnavailableError(null, new Error('Invalid /models response shape'));
  }
  return result;
};
