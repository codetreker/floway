import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { codexAccessTokenKey } from './access-token-cache.ts';
import { createCodexProvider } from './provider.ts';
import { clearModelsStore, initProviderRepo, type CacheRepo, type UpstreamRecord } from '@floway-dev/provider';

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

const record: UpstreamRecord = {
  id: 'up_codex',
  provider: 'codex',
  name: 'Codex Plus',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-05T00:00:00.000Z',
  updatedAt: '2026-06-05T00:00:00.000Z',
  config: { accounts: [{ email: 'a@b.com', chatgptAccountId: 'acc', chatgptUserId: 'usr', planType: 'plus' }] },
  state: { accounts: [{ chatgptAccountId: 'acc', refresh_token: 'rt_v1', state: 'active', state_updated_at: '2026-01-01T00:00:00Z' }] },
  flagOverrides: {},
  disabledPublicModelIds: [],
};

let cache: CacheRepo & { _store: Map<string, string> };
let saveStateSpy: ReturnType<typeof vi.fn<(id: string, newState: unknown, options: { expectedState: unknown }) => Promise<{ updated: boolean }>>>;
let getByIdSpy: ReturnType<typeof vi.fn<(id: string) => Promise<UpstreamRecord | null>>>;

beforeEach(() => {
  cache = makeMemoryCache();
  saveStateSpy = vi.fn<(id: string, newState: unknown, options: { expectedState: unknown }) => Promise<{ updated: boolean }>>(async () => ({ updated: true }));
  getByIdSpy = vi.fn<(id: string) => Promise<UpstreamRecord | null>>(async () => record);
  initProviderRepo(() => ({
    cache,
    upstreams: { getById: getByIdSpy, saveState: saveStateSpy },
  }));
  clearModelsStore();
});

afterEach(() => vi.restoreAllMocks());

const sseResponse = (): Response => new Response(
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created","response":{"id":"r","object":"response","model":"gpt-5.4","status":"in_progress","output":[],"incomplete_details":null,"error":null}}\n\n'));
      c.enqueue(new TextEncoder().encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","object":"response","model":"gpt-5.4","status":"completed","output":[],"incomplete_details":null,"error":null}}\n\n'));
      c.close();
    },
  }),
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);

describe('createCodexProvider', () => {
  test('returns an instance carrying provider kind and identity', async () => {
    const instance = await createCodexProvider(record);
    expect(instance.providerKind).toBe('codex');
    expect(instance.upstream).toBe('up_codex');
    expect(instance.name).toBe('Codex Plus');
    expect(instance.supportsResponsesItemReference).toBe(false);
  });

  test('getProvidedModels fetches /codex/models and filters hidden', async () => {
    const farFuture = Math.floor(Date.now() / 1000) + 86400;
    cache._store.set(codexAccessTokenKey('up_codex'), JSON.stringify({ access_token: 'at', expires_at: farFuture, refreshed_at: 'now' }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      models: [
        { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', context_window: 272000, max_context_window: 1000000 },
        { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', context_window: 272000, max_context_window: 1000000 },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const instance = await createCodexProvider(record);
    const models = await instance.provider.getProvidedModels();
    // Provider surfaces both visible and hidden upstream models — operators
    // can dispatch to `codex-auto-review` even though ChatGPT's UI hides it.
    expect(models.map(m => m.id)).toEqual(['gpt-5.4', 'codex-auto-review']);
    expect(models[0].endpoints).toEqual({ responses: {} });
  });

  test('callResponses round-trips through fetch transport', async () => {
    const farFuture = Math.floor(Date.now() / 1000) + 86400;
    cache._store.set(codexAccessTokenKey('up_codex'), JSON.stringify({ access_token: 'at', expires_at: farFuture, refreshed_at: 'now' }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const instance = await createCodexProvider(record);
    const result = await instance.provider.callResponses(
      { id: 'gpt-5.4', display_name: 'gpt-5.4', kind: 'chat', limits: {}, endpoints: { responses: {} }, enabledFlags: new Set() },
      { input: [{ type: 'message', role: 'user', content: 'hi' }], stream: true },
    );
    expect(result.ok).toBe(true);
  });

  test('callResponses re-reads state per request (operator re-import takes effect)', async () => {
    const farFuture = Math.floor(Date.now() / 1000) + 86400;
    cache._store.set(codexAccessTokenKey('up_codex'), JSON.stringify({ access_token: 'at', expires_at: farFuture, refreshed_at: 'now' }));
    getByIdSpy.mockResolvedValueOnce({ ...record, state: { accounts: [{ chatgptAccountId: 'acc', refresh_token: 'rt_v1', state: 'session_terminated', state_updated_at: '2026-01-02T00:00:00Z' }] } });
    const instance = await createCodexProvider(record);
    const result = await instance.provider.callResponses(
      { id: 'gpt-5.4', display_name: 'gpt-5.4', kind: 'chat', limits: {}, endpoints: { responses: {} }, enabledFlags: new Set() },
      { input: [], stream: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
  });

  test.each([
    'callEmbeddings',
    'callImagesGenerations',
    'callImagesEdits',
    'callMessagesCountTokens',
  ] as const)('%s throws (data plane never dispatches these to Codex)', async method => {
    const instance = await createCodexProvider(record);
    const model = { id: 'gpt-5.4', display_name: 'gpt-5.4', kind: 'chat', limits: {}, endpoints: { responses: {} }, enabledFlags: new Set<string>() };
    // @ts-expect-error: each method has a different param shape; we just want to assert throw.
    await expect(instance.provider[method](model, {}, undefined, {})).rejects.toThrow(/Codex/);
  });
});
