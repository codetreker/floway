import { describe, expect, test } from 'vitest';

import { codexQuotaKey, getCodexQuota, isCodexRateLimited, parseCodexQuotaHeaders, putCodexQuota } from './quota.ts';
import type { CacheRepo } from '@floway-dev/provider';

const makeMemoryCache = (): CacheRepo => {
  const store = new Map<string, string>();
  return {
    get: async k => store.get(k) ?? null,
    set: async (k, v) => { store.set(k, v); },
    delete: async k => { store.delete(k); },
    deletePrefix: async p => { for (const k of [...store.keys()]) if (k.startsWith(p)) store.delete(k); },
  };
};

describe('parseCodexQuotaHeaders', () => {
  test('parses a 200 snapshot (no ratelimited_until)', () => {
    const headers = new Headers({
      'x-codex-active-limit': 'premium',
      'x-codex-plan-type': 'plus',
      'x-codex-primary-used-percent': '42',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '18000',
      'x-codex-secondary-used-percent': '94',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-after-seconds': '486400',
      'x-codex-credits-has-credits': 'False',
      'x-codex-credits-balance': '0',
    });
    const observedAt = new Date('2026-06-05T00:00:00.000Z');
    const snapshot = parseCodexQuotaHeaders(headers, { now: observedAt, isRateLimited: false });
    expect(snapshot).toMatchObject({
      observed_at: '2026-06-05T00:00:00.000Z',
      active_limit: 'premium',
      plan_type: 'plus',
      primary_used_percent: 42,
      primary_window_minutes: 300,
      primary_reset_after_at: '2026-06-05T05:00:00.000Z',
      secondary_used_percent: 94,
      secondary_window_minutes: 10080,
      credits_has_credits: false,
      credits_balance: 0,
    });
    expect(snapshot.ratelimited_until).toBeUndefined();
  });

  test('sets ratelimited_until from max(primary, secondary) reset window on 429', () => {
    const headers = new Headers({
      'x-codex-primary-reset-after-seconds': '3600',
      'x-codex-secondary-reset-after-seconds': '7200',
    });
    const observedAt = new Date('2026-06-05T00:00:00.000Z');
    const snapshot = parseCodexQuotaHeaders(headers, { now: observedAt, isRateLimited: true });
    expect(snapshot.ratelimited_until).toBe('2026-06-05T02:00:00.000Z');
  });

  test('survives missing optional headers', () => {
    const observedAt = new Date('2026-06-05T00:00:00.000Z');
    const snapshot = parseCodexQuotaHeaders(new Headers({}), { now: observedAt, isRateLimited: false });
    expect(snapshot).toEqual({ observed_at: '2026-06-05T00:00:00.000Z' });
  });
});

describe('codex quota KV', () => {
  test('key namespacing', () => {
    expect(codexQuotaKey('up_x')).toBe('codex_quota:up_x');
  });

  test('put → get round-trips', async () => {
    const cache = makeMemoryCache();
    const snap = { observed_at: '2026-06-05T00:00:00.000Z', primary_used_percent: 10 };
    await putCodexQuota(cache, 'up_x', snap);
    expect(await getCodexQuota(cache, 'up_x')).toEqual(snap);
  });

  test('get returns null for missing/malformed', async () => {
    const cache = makeMemoryCache();
    expect(await getCodexQuota(cache, 'absent')).toBeNull();
  });
});

describe('isCodexRateLimited', () => {
  test('true when ratelimited_until is in the future', () => {
    expect(isCodexRateLimited({ observed_at: 'x', ratelimited_until: '2026-06-05T01:00:00.000Z' }, new Date('2026-06-05T00:00:00.000Z'))).toBe(true);
  });
  test('false when reset time has passed', () => {
    expect(isCodexRateLimited({ observed_at: 'x', ratelimited_until: '2026-06-05T00:00:00.000Z' }, new Date('2026-06-05T01:00:00.000Z'))).toBe(false);
  });
  test('false when ratelimited_until absent', () => {
    expect(isCodexRateLimited({ observed_at: 'x' }, new Date())).toBe(false);
  });
  test('false for null snapshot', () => {
    expect(isCodexRateLimited(null, new Date())).toBe(false);
  });
});
