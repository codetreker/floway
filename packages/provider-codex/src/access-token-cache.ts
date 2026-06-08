import type { CacheRepo } from '@floway-dev/provider';

export interface CodexAccessTokenCache {
  access_token: string;
  expires_at: number;          // epoch seconds
  refreshed_at: string;        // ISO 8601
}

export const codexAccessTokenKey = (upstreamId: string): string => `codex_access:${upstreamId}`;

// Malformed entries return null rather than throwing — a corrupt cache row
// should never block a request; the request lifecycle will refresh and rewrite.
export const getCodexAccessToken = async (cache: CacheRepo, upstreamId: string): Promise<CodexAccessTokenCache | null> => {
  const raw = await cache.get(codexAccessTokenKey(upstreamId));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.access_token !== 'string' || typeof obj.expires_at !== 'number' || typeof obj.refreshed_at !== 'string') return null;
    return { access_token: obj.access_token, expires_at: obj.expires_at, refreshed_at: obj.refreshed_at };
  } catch {
    return null;
  }
};

export const putCodexAccessToken = async (cache: CacheRepo, upstreamId: string, entry: CodexAccessTokenCache, ttlMs?: number): Promise<void> => {
  await cache.set(codexAccessTokenKey(upstreamId), JSON.stringify(entry), ttlMs);
};

export const invalidateCodexAccessToken = async (cache: CacheRepo, upstreamId: string): Promise<void> => {
  await cache.delete(codexAccessTokenKey(upstreamId));
};
