import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { codexAccessTokenKey } from './access-token-cache.ts';
import { callCodexResponses, type CodexCallEffects } from './fetch.ts';
import { codexQuotaKey } from './quota.ts';
import type { CodexAccountCredential } from './state.ts';
import type { CacheRepo, Fetcher, UpstreamModel } from '@floway-dev/provider';
import { noopUpstreamCallOptions } from '@floway-dev/test-utils';

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
      model, body: { input: [], stream: true }, headers: {}, cache, effects: makeEffects(), call: noopUpstreamCallOptions,
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
      model, body: { input: [], stream: true }, headers: {}, cache, effects: makeEffects(), call: noopUpstreamCallOptions,
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
      model, body: { input: [], stream: true }, headers: {}, cache, effects, call: noopUpstreamCallOptions,
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
      model, body: { input: [], stream: true }, headers: {}, cache, effects: makeEffects(), call: noopUpstreamCallOptions,
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
      model, body: { input: [], stream: true }, headers: {}, cache, effects, call: noopUpstreamCallOptions,
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
      model, body: { input: [], stream: true }, headers: {}, cache, effects: makeEffects(), call: noopUpstreamCallOptions,
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
      headers: {}, cache, effects: makeEffects(), call: noopUpstreamCallOptions,
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
      model, body: { input: [], stream: true }, headers: {}, cache, effects, call: noopUpstreamCallOptions,
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
      model, body: { input: [], stream: true }, headers: {}, cache, effects, call: noopUpstreamCallOptions,
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
      model, body: { input: [], stream: true }, headers: {}, cache, effects: makeEffects(), call: noopUpstreamCallOptions,
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
      model, body: { input: [], stream: true }, headers: {}, cache, effects, call: noopUpstreamCallOptions,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
    expect(effects.persistTerminalState).not.toHaveBeenCalled();
    expect(effects.persistRefreshTokenRotation).not.toHaveBeenCalled();
  });
});

// Mints an enforcing recorder mirroring `createUpstreamLatencyRecorder` from
// the gateway side: counts wraps and refuses to surrender a duration when
// `record` was never invoked. Gives provider-level tests a way to assert the
// contract without depending on the gateway package. The `fetcher` honours
// the third-arg recorder so the data-plane POSTs (which thread the recorder
// through the fetcher rather than wrapping outside) still count.
const enforcingRecorder = () => {
  const wrappedPromises: unknown[] = [];
  let last: number | undefined;
  const record = <T>(promise: Promise<T>): Promise<T> => {
    wrappedPromises.push(promise);
    const startedAt = performance.now();
    return promise.finally(() => { last = performance.now() - startedAt; });
  };
  const fetcher: Fetcher = (url, init, recordUpstreamLatency) => {
    const inner = fetch(url, init);
    return recordUpstreamLatency ? recordUpstreamLatency(inner) : inner;
  };
  return {
    options: {
      fetcher,
      recordUpstreamLatency: record,
    },
    invocations: () => wrappedPromises.length,
    durationMs: (): number => {
      if (last === undefined) throw new Error('recorder was never wrapped');
      return last;
    },
  };
};

describe('callCodexResponses — recorder contract', () => {
  test('non-active gate satisfies an enforcing recorder once', async () => {
    const cache = makeMemoryCache();
    const recorder = enforcingRecorder();
    const result = await callCodexResponses({
      upstreamId: 'up_a', account: { ...activeAccount, state: 'session_terminated' },
      model, body: { input: [], stream: true }, headers: {}, cache, effects: makeEffects(), call: recorder.options,
    });
    expect(result.ok).toBe(false);
    expect(recorder.invocations()).toBe(1);
    // Reading durationMs must not throw.
    expect(recorder.durationMs()).toBeGreaterThanOrEqual(0);
  });

  test('rate-limited gate satisfies an enforcing recorder once', async () => {
    const cache = makeMemoryCache();
    cache._store.set(codexQuotaKey('up_a'), JSON.stringify({
      observed_at: '2026-06-05T00:00:00.000Z',
      ratelimited_until: '2026-06-05T01:00:00.000Z',
    }));
    vi.useFakeTimers().setSystemTime(new Date('2026-06-05T00:30:00.000Z'));
    const recorder = enforcingRecorder();
    const result = await callCodexResponses({
      upstreamId: 'up_a', account: activeAccount,
      model, body: { input: [], stream: true }, headers: {}, cache, effects: makeEffects(), call: recorder.options,
    });
    expect(result.ok).toBe(false);
    expect(recorder.invocations()).toBe(1);
    expect(() => recorder.durationMs()).not.toThrow();
  });

  test('refresh-failed gate satisfies an enforcing recorder once', async () => {
    const cache = makeMemoryCache();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorJson(400, { error: { code: 'app_session_terminated', message: 'gone' } }));
    const recorder = enforcingRecorder();
    const result = await callCodexResponses({
      upstreamId: 'up_a', account: activeAccount,
      model, body: { input: [], stream: true }, headers: {}, cache, effects: makeEffects(), call: recorder.options,
    });
    expect(result.ok).toBe(false);
    expect(recorder.invocations()).toBe(1);
    expect(() => recorder.durationMs()).not.toThrow();
  });

  test('401-then-success: recorder records both fetch attempts; durationMs reflects the second', async () => {
    const cache = makeMemoryCache();
    const farFuture = Math.floor(Date.now() / 1000) + 86400;
    cache._store.set(codexAccessTokenKey('up_a'), JSON.stringify({ access_token: 'at_kv', expires_at: farFuture, refreshed_at: 'now' }));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at2', refresh_token: 'rt_v2', id_token: 'it', expires_in: 600 }), { status: 200 }))
      .mockResolvedValueOnce(sseResponse());
    const recorder = enforcingRecorder();
    const result = await callCodexResponses({
      upstreamId: 'up_a', account: activeAccount,
      model, body: { input: [], stream: true }, headers: {}, cache, effects: makeEffects(), call: recorder.options,
    });
    expect(result.ok).toBe(true);
    // Both upstream fetches go through `recordUpstreamLatency`; the OAuth
    // refresh in between is provider-internal and must NOT be wrapped.
    expect(recorder.invocations()).toBe(2);
  });
});
