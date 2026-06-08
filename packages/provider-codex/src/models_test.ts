import { afterEach, describe, expect, test, vi } from 'vitest';

import { CODEX_CLI_VERSION } from './constants.ts';
import { codexRawToUpstreamModel, fetchCodexCatalog } from './models.ts';

const okJson = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.restoreAllMocks());

describe('fetchCodexCatalog', () => {
  test('calls /codex/models with auth + identity headers, returns parsed catalog from {models: [...]}', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      models: [
        { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', context_window: 272000, max_context_window: 1000000 },
        { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', visibility: 'list', context_window: 272000, max_context_window: 272000 },
        { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', context_window: 272000, max_context_window: 1000000 },
      ],
    }));
    const catalog = await fetchCodexCatalog({ accessToken: 'at', accountId: 'acc' });
    expect(catalog).toHaveLength(3);
    expect(catalog[0]).toEqual({ id: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000, max_context_window: 1000000 });
    expect(catalog[2]).toEqual({ id: 'codex-auto-review', display_name: 'Codex Auto Review', context_window: 272000, max_context_window: 1000000 });
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLI_VERSION}`);
    const headers = new Headers((init as RequestInit | undefined)?.headers);
    expect(headers.get('authorization')).toBe('Bearer at');
    expect(headers.get('chatgpt-account-id')).toBe('acc');
    expect(headers.get('originator')).toBe('codex_cli_rs');
    expect(headers.get('user-agent')).toBe(`codex_cli_rs/${CODEX_CLI_VERSION}`);
    expect(headers.get('openai-beta')).toBeNull();
  });

  test('throws when upstream returns non-2xx (caller handles 401 retry)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));
    await expect(fetchCodexCatalog({ accessToken: 'at', accountId: 'acc' })).rejects.toThrow(/401/);
  });

  test('throws on missing models key (forward-compatible shape guard)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ data: [] }));
    await expect(fetchCodexCatalog({ accessToken: 'at', accountId: 'acc' })).rejects.toThrow(/models array/);
  });

  test('throws on entry missing slug', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ models: [{ display_name: 'no slug here' }] }));
    await expect(fetchCodexCatalog({ accessToken: 'at', accountId: 'acc' })).rejects.toThrow(/slug/);
  });
});

describe('codexRawToUpstreamModel', () => {
  test('shapes raw → UpstreamModel with responses-only endpoint and per-request context window', () => {
    const m = codexRawToUpstreamModel({ id: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000, max_context_window: 1000000 });
    expect(m.id).toBe('gpt-5.4');
    expect(m.display_name).toBe('GPT-5.4');
    expect(m.endpoints).toEqual({ responses: {} });
    expect(m.kind).toBe('chat');
    expect(m.limits.max_context_window_tokens).toBe(272000);
    expect(m.owned_by).toBe('openai');
  });

  test('falls back to max_context_window when context_window is zero', () => {
    const m = codexRawToUpstreamModel({ id: 'm', display_name: 'm', context_window: 0, max_context_window: 50000 });
    expect(m.limits.max_context_window_tokens).toBe(50000);
  });

  test('attaches OpenAI-API-rate cost for known slugs and treats codex-auto-review as gpt-5.4', () => {
    const flagship = codexRawToUpstreamModel({ id: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000, max_context_window: 1000000 });
    expect(flagship.cost).toEqual({ input: 2.5, input_cache_read: 0.25, output: 15 });
    const review = codexRawToUpstreamModel({ id: 'codex-auto-review', display_name: 'Codex Auto Review', context_window: 272000, max_context_window: 1000000 });
    expect(review.cost).toEqual(flagship.cost);
  });

  test('omits cost for unknown slugs (forward-compat with new upstream models)', () => {
    const m = codexRawToUpstreamModel({ id: 'gpt-future-unreleased', display_name: 'X', context_window: 1, max_context_window: 1 });
    expect(m.cost).toBeUndefined();
  });
});
