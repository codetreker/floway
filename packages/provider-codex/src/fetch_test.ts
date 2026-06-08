import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { codexAccessTokenKey } from './access-token-cache.ts';
import { callCodexResponses, type CodexCallEffects } from './fetch.ts';
import { codexQuotaKey } from './quota.ts';
import type { CodexAccountCredential } from './state.ts';
import type { CacheRepo, UpstreamModel } from '@floway-dev/provider';

const makeMemoryCache = (): CacheRepo & { _store: Map<string, string> } => {
  const store = new Map<string, string>();
  return {
    _store: store,
    get: async k => store.get(k) ?? null,
    set: async (k, v) => { store.set(k, v); },
    delete: async k => { store.delete(k); },
    deletePrefix: async p => { for (const k of [...store.keys()]) if (k.startsWith(p)) store.delete(k); },
  };
};

const makeEffects = (): CodexCallEffects => ({
  persistRefreshTokenRotation: vi.fn(async () => {}),
  persistTerminalState: vi.fn(async () => {}),
});

const sseResponse = (status = 200): Response => new Response(
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created"}\n\n'));
      c.close();
    },
  }),
  {
    status,
    headers: {
      'content-type': 'text/event-stream',
      'x-codex-active-limit': 'premium',
      'x-codex-plan-type': 'plus',
      'x-codex-primary-used-percent': '42',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '18000',
    },
  },
);

const errorJson = (status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extraHeaders } });

const activeAccount: CodexAccountCredential = { chatgptAccountId: 'acc', refresh_token: 'rt_v1', state: 'active', state_updated_at: '2026-01-01T00:00:00Z' };
const model: UpstreamModel = {
  id: 'gpt-5.4', display_name: 'gpt-5.4', kind: 'chat', limits: {}, endpoints: { responses: {} }, enabledFlags: new Set(),
};

afterEach(() => vi.restoreAllMocks());
beforeEach(() => vi.useRealTimers());

describe('callCodexResponses — gates', () => {
  test('refuses non-active state with synthetic 503', async () => {
    const cache = makeMemoryCache();
    const result = await callCodexResponses({
      upstreamId: 'up_a', account: { ...activeAccount, state: 'session_terminated' },
      model, body: { input: [], stream: true }, headers: {}, cache, effects: makeEffects(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      expect(await result.response.text()).toMatch(/session_terminated/);
    }
  });

  test('refuses while rate-limited window is open', async () => {
    const cache = makeMemoryCache();
    cache._store.set(codexQuotaKey('up_a'), JSON.stringify({
      observed_at: '2026-06-05T00:00:00.000Z',
      ratelimited_until: '2026-06-05T01:00:00.000Z',
    }));
    vi.useFakeTimers().setSystemTime(new Date('2026-06-05T00:30:00.000Z'));
    const result = await callCodexResponses({
      upstreamId: 'up_a', account: activeAccount,
      model, body: { input: [], stream: true }, headers: {}, cache, effects: makeEffects(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(429);
      expect(result.response.headers.get('retry-after')).toBeTruthy();
    }
  });
});

describe('callCodexResponses — token freshness', () => {
  test('refreshes before call when KV is empty', async () => {
    const cache = makeMemoryCache();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at_new', refresh_token: 'rt_v2', id_token: 'it', expires_in: 600 }), { status: 200 }))
      .mockResolvedValueOnce(sseResponse());
    const effects = makeEffects();
    const result = await callCodexResponses({
      upstreamId: 'up_a', account: activeAccount,
      model, body: { input: [], stream: true }, headers: {}, cache, effects,
    });
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const responsesInit = fetchSpy.mock.calls[1][1] as RequestInit;
    expect(new Headers(responsesInit.headers).get('authorization')).toBe('Bearer at_new');
    expect(effects.persistRefreshTokenRotation).toHaveBeenCalledWith('rt_v2');
    expect(cache._store.get(codexAccessTokenKey('up_a'))).toContain('at_new');
  });

  test('reuses fresh KV access token without refreshing', async () => {
    const cache = makeMemoryCache();
    const farFuture = Math.floor(Date.now() / 1000) + 60 * 60 * 24;
    cache._store.set(codexAccessTokenKey('up_a'), JSON.stringify({ access_token: 'at_kv', expires_at: farFuture, refreshed_at: 'now' }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId: 'up_a', account: activeAccount,
      model, body: { input: [], stream: true }, headers: {}, cache, effects: makeEffects(),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers).get('authorization')).toBe('Bearer at_kv');
  });

  test('persistTerminalState refresh_failed when /oauth/token returns app_session_terminated', async () => {
    const cache = makeMemoryCache();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorJson(400, { error: { code: 'app_session_terminated', message: 'gone' } }));
    const effects = makeEffects();
    const result = await callCodexResponses({
      upstreamId: 'up_a', account: activeAccount,
      model, body: { input: [], stream: true }, headers: {}, cache, effects,
    });
    expect(result.ok).toBe(false);
    expect(effects.persistTerminalState).toHaveBeenCalledWith('refresh_failed', expect.stringMatching(/gone/));
  });
});

describe('callCodexResponses — upstream classification', () => {
  test('happy path: 200 → ok:true, quota persisted', async () => {
    const cache = makeMemoryCache();
    const farFuture = Math.floor(Date.now() / 1000) + 86400;
    cache._store.set(codexAccessTokenKey('up_a'), JSON.stringify({ access_token: 'at_kv', expires_at: farFuture, refreshed_at: 'now' }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const result = await callCodexResponses({
      upstreamId: 'up_a', account: activeAccount,
      model, body: { input: [], stream: true }, headers: {}, cache, effects: makeEffects(),
    });
    expect(result.ok).toBe(true);
    const stored = cache._store.get(codexQuotaKey('up_a'));
    expect(stored).toContain('"primary_used_percent":42');
    expect(stored).not.toContain('ratelimited_until');
  });

  test('upstream body has store:false and stream:true forced even if caller passes otherwise', async () => {
    const cache = makeMemoryCache();
    const farFuture = Math.floor(Date.now() / 1000) + 86400;
    cache._store.set(codexAccessTokenKey('up_a'), JSON.stringify({ access_token: 'at_kv', expires_at: farFuture, refreshed_at: 'now' }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId: 'up_a', account: activeAccount,
      model, body: { input: [], stream: false as unknown as true, store: true } as unknown as Parameters<typeof callCodexResponses>[0]['body'],
      headers: {}, cache, effects: makeEffects(),
    });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe('gpt-5.4');
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
  });

  test('401 token_invalidated → persistTerminalState session_terminated, return 503', async () => {
    const cache = makeMemoryCache();
    const farFuture = Math.floor(Date.now() / 1000) + 86400;
    cache._store.set(codexAccessTokenKey('up_a'), JSON.stringify({ access_token: 'at_kv', expires_at: farFuture, refreshed_at: 'now' }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(401, { error: { code: 'token_invalidated', message: 'session ended' } }));
    const effects = makeEffects();
    const result = await callCodexResponses({
      upstreamId: 'up_a', account: activeAccount,
      model, body: { input: [], stream: true }, headers: {}, cache, effects,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
    expect(effects.persistTerminalState).toHaveBeenCalledWith('session_terminated', expect.stringMatching(/session ended/));
  });

  test('401 other → refresh + retry once, then bubble persistent 401', async () => {
    const cache = makeMemoryCache();
    const farFuture = Math.floor(Date.now() / 1000) + 86400;
    cache._store.set(codexAccessTokenKey('up_a'), JSON.stringify({ access_token: 'at_kv', expires_at: farFuture, refreshed_at: 'now' }));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at2', refresh_token: 'rt_v2', id_token: 'it', expires_in: 600 }), { status: 200 }))
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'still expired' } }));
    const effects = makeEffects();
    const result = await callCodexResponses({
      upstreamId: 'up_a', account: activeAccount,
      model, body: { input: [], stream: true }, headers: {}, cache, effects,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    expect(effects.persistRefreshTokenRotation).toHaveBeenCalledWith('rt_v2');
  });

  test('429 → quota with ratelimited_until, return upstream 429', async () => {
    const cache = makeMemoryCache();
    const farFuture = Math.floor(Date.now() / 1000) + 86400;
    cache._store.set(codexAccessTokenKey('up_a'), JSON.stringify({ access_token: 'at_kv', expires_at: farFuture, refreshed_at: 'now' }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(429, { error: { type: 'usage_limit_reached', message: 'cap reached', resets_in_seconds: 7200 } }, {
      'x-codex-primary-reset-after-seconds': '3600',
      'x-codex-secondary-reset-after-seconds': '7200',
    }));
    const result = await callCodexResponses({
      upstreamId: 'up_a', account: activeAccount,
      model, body: { input: [], stream: true }, headers: {}, cache, effects: makeEffects(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(429);
    const stored = cache._store.get(codexQuotaKey('up_a'));
    expect(stored).toContain('ratelimited_until');
  });

  test('5xx passes through without touching state', async () => {
    const cache = makeMemoryCache();
    const farFuture = Math.floor(Date.now() / 1000) + 86400;
    cache._store.set(codexAccessTokenKey('up_a'), JSON.stringify({ access_token: 'at_kv', expires_at: farFuture, refreshed_at: 'now' }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(503, { error: 'unavailable' }));
    const effects = makeEffects();
    const result = await callCodexResponses({
      upstreamId: 'up_a', account: activeAccount,
      model, body: { input: [], stream: true }, headers: {}, cache, effects,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
    expect(effects.persistTerminalState).not.toHaveBeenCalled();
    expect(effects.persistRefreshTokenRotation).not.toHaveBeenCalled();
  });
});
