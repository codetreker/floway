import { afterEach, describe, expect, test, vi } from 'vitest';

import { codexAccessTokenKey } from './access-token-cache.ts';
import { callCodexResponsesCompact } from './compaction.ts';
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

const compactionSseResponse = (): Response => {
  const events = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_x","object":"response","model":"gpt-5.4","status":"in_progress","output":[],"incomplete_details":null,"error":null}}\n\n',
    'event: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"resp_x","object":"response","model":"gpt-5.4","status":"in_progress","output":[],"incomplete_details":null,"error":null}}\n\n',
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"cmp_x","type":"compaction","encrypted_content":"PARTIAL"}}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"cmp_x","type":"compaction","encrypted_content":"FULL_BLOB"}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_x","object":"response","model":"gpt-5.4","status":"completed","output":[],"incomplete_details":null,"error":null,"usage":{"input_tokens":550,"output_tokens":167,"total_tokens":717}}}\n\n',
  ];
  return new Response(
    new ReadableStream({
      start(c) {
        for (const e of events) c.enqueue(new TextEncoder().encode(e));
        c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
};

const activeAccount: CodexAccountCredential = { chatgptAccountId: 'acc', refresh_token: 'rt', state: 'active', state_updated_at: '2026-01-01T00:00:00Z' };
const model: UpstreamModel = { id: 'gpt-5.4', display_name: 'gpt-5.4', kind: 'chat', limits: {}, endpoints: { responses: {} }, enabledFlags: new Set() };

afterEach(() => vi.restoreAllMocks());

describe('callCodexResponsesCompact', () => {
  test('appends compaction_trigger, forces store:false & stream:true, returns rebuilt envelope', async () => {
    const cache = makeMemoryCache();
    const far = Math.floor(Date.now() / 1000) + 86400;
    cache._store.set(codexAccessTokenKey('up'), JSON.stringify({ access_token: 'at', expires_at: far, refreshed_at: 'now' }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(compactionSseResponse());
    const result = await callCodexResponsesCompact({
      upstreamId: 'up', account: activeAccount, model,
      body: { input: [{ type: 'message', role: 'user', content: 'hello' }] },
      cache, headers: {}, effects: { persistRefreshTokenRotation: async () => {}, persistTerminalState: async () => {} },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sentBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.input.at(-1)).toEqual({ type: 'compaction_trigger' });
    expect(sentBody.store).toBe(false);
    expect(sentBody.stream).toBe(true);

    expect(result.result.object).toBe('response.compaction');
    expect(result.result.output).toHaveLength(2);
    expect(result.result.output[1]).toMatchObject({ id: 'cmp_x', type: 'compaction', encrypted_content: 'FULL_BLOB' });
  });

  test('errors if upstream returns zero compaction items (defensive)', async () => {
    const cache = makeMemoryCache();
    const far = Math.floor(Date.now() / 1000) + 86400;
    cache._store.set(codexAccessTokenKey('up'), JSON.stringify({ access_token: 'at', expires_at: far, refreshed_at: 'now' }));
    const badResponse = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created","response":{"id":"r","object":"response","model":"gpt-5.4","status":"in_progress","output":[],"incomplete_details":null,"error":null}}\n\n'));
          c.enqueue(new TextEncoder().encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","object":"response","model":"gpt-5.4","status":"completed","output":[],"incomplete_details":null,"error":null}}\n\n'));
          c.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(badResponse);
    await expect(callCodexResponsesCompact({
      upstreamId: 'up', account: activeAccount, model,
      body: { input: [{ type: 'message', role: 'user', content: 'hi' }] },
      cache, headers: {}, effects: { persistRefreshTokenRotation: async () => {}, persistTerminalState: async () => {} },
    })).rejects.toThrow(/compaction/);
  });

  test('propagates upstream ok:false (non-2xx) unchanged', async () => {
    const cache = makeMemoryCache();
    const far = Math.floor(Date.now() / 1000) + 86400;
    cache._store.set(codexAccessTokenKey('up'), JSON.stringify({ access_token: 'at', expires_at: far, refreshed_at: 'now' }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('upstream-error', { status: 500 }));
    const result = await callCodexResponsesCompact({
      upstreamId: 'up', account: activeAccount, model,
      body: { input: [{ type: 'message', role: 'user', content: 'hi' }] },
      cache, headers: {}, effects: { persistRefreshTokenRotation: async () => {}, persistTerminalState: async () => {} },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(500);
  });
});
