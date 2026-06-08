import { describe, expect, test } from 'vitest';

import { codexAccessTokenKey, getCodexAccessToken, invalidateCodexAccessToken, putCodexAccessToken } from './access-token-cache.ts';
import type { CacheRepo } from '@floway-dev/provider';

// In-memory CacheRepo for tests; mimics the live KV adapter shape.
const makeMemoryCache = (): CacheRepo & { _store: Map<string, string> } => {
  const store = new Map<string, string>();
  return {
    _store: store,
    get: async key => store.get(key) ?? null,
    set: async (key, value) => { store.set(key, value); },
    delete: async key => { store.delete(key); },
    deletePrefix: async prefix => { for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k); },
  };
};

describe('codex access-token cache', () => {
  test('key namespacing is per-upstream', () => {
    expect(codexAccessTokenKey('up_a')).toBe('codex_access:up_a');
    expect(codexAccessTokenKey('up_b')).toBe('codex_access:up_b');
  });

  test('put → get round-trips', async () => {
    const cache = makeMemoryCache();
    await putCodexAccessToken(cache, 'up_a', { access_token: 'at_x', expires_at: 9999, refreshed_at: '2026-06-05T00:00:00.000Z' });
    expect(await getCodexAccessToken(cache, 'up_a')).toEqual({ access_token: 'at_x', expires_at: 9999, refreshed_at: '2026-06-05T00:00:00.000Z' });
  });

  test('get returns null for unknown upstream', async () => {
    const cache = makeMemoryCache();
    expect(await getCodexAccessToken(cache, 'up_missing')).toBeNull();
  });

  test('get returns null for malformed cache entry (does not throw)', async () => {
    const cache = makeMemoryCache();
    cache._store.set(codexAccessTokenKey('up_a'), 'not json');
    expect(await getCodexAccessToken(cache, 'up_a')).toBeNull();
  });

  test('invalidate removes the entry', async () => {
    const cache = makeMemoryCache();
    await putCodexAccessToken(cache, 'up_a', { access_token: 'at_x', expires_at: 1, refreshed_at: 'now' });
    await invalidateCodexAccessToken(cache, 'up_a');
    expect(await getCodexAccessToken(cache, 'up_a')).toBeNull();
  });
});
