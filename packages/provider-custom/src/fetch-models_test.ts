import { test } from 'vitest';

import { assertCustomUpstreamRecord, fetchCustomModels } from './index.ts';
import { isProviderModelsHttpStatus, ProviderModelsUnavailableError } from '@floway-dev/provider';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const upstreamRecord = () => ({
  id: 'up_custom',
  provider: 'custom' as const,
  name: 'Custom',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  config: {
    baseUrl: 'https://custom.example.com',
    bearerToken: 'token',
    endpoints: { chatCompletions: {} },
  },
  state: null,
});

test('fetchCustomModels returns the parsed response on 2xx', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'm-1' }] }),
    async () => {
      const result = await fetchCustomModels(config);
      assertEquals(result.data[0].id, 'm-1');
    },
  );
});

test('fetchCustomModels accepts an Anthropic-shape response with no top-level `object`', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({
      data: [{ type: 'model', id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5', created_at: '2026-01-01T00:00:00Z' }],
      has_more: false,
      first_id: 'claude-opus-4-5',
      last_id: 'claude-opus-4-5',
    }),
    async () => {
      const result = await fetchCustomModels(config);
      assertEquals(result.data.length, 1);
      assertEquals(result.data[0].id, 'claude-opus-4-5');
      assertEquals(result.data[0].display_name, 'Claude Opus 4.5');
      assertEquals(result.data[0].created_at, '2026-01-01T00:00:00Z');
    },
  );
});

test('fetchCustomModels reads superset fields (display_name, limits, cost) from our own /models', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      has_more: false,
      first_id: 'm-1',
      last_id: 'm-1',
      data: [
        {
          id: 'm-1',
          object: 'model',
          type: 'model',
          display_name: 'Model One',
          created: 1700000000,
          created_at: '2023-11-14T22:13:20Z',
          owned_by: 'me',
          limits: { max_output_tokens: 4096, max_context_window_tokens: 200000 },
          kind: 'chat',
          cost: { input: 1, output: 2, input_cache_read: 0.1, input_cache_write: 1.25 },
        },
      ],
    }),
    async () => {
      const result = await fetchCustomModels(config);
      const model = result.data[0];
      assertEquals(model.id, 'm-1');
      assertEquals(model.display_name, 'Model One');
      assertEquals(model.created, 1700000000);
      assertEquals(model.created_at, '2023-11-14T22:13:20Z');
      assertEquals(model.owned_by, 'me');
      assertEquals(model.limits?.max_output_tokens, 4096);
      assertEquals(model.limits?.max_context_window_tokens, 200000);
      assertEquals(model.cost?.input, 1);
      assertEquals(model.cost?.output, 2);
      assertEquals(model.cost?.input_cache_read, 0.1);
      assertEquals(model.cost?.input_cache_write, 1.25);
    },
  );
});

test('fetchCustomModels keeps a `cost` block with any subset of billing dimensions', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'm-1', cost: { input: 1 } }] }),
    async () => {
      const result = await fetchCustomModels(config);
      assertEquals(result.data[0].cost, { input: 1 });
    },
  );
});

test('fetchCustomModels drops a `cost` block with no recognized dimensions', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'm-1', cost: { reasoning: 5 } }] }),
    async () => {
      const result = await fetchCustomModels(config);
      assertEquals(result.data[0].cost, undefined);
    },
  );
});

test('fetchCustomModels skips entries whose id is not a non-empty string', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'ok' }, { id: '' }, { id: 123 }, { display_name: 'no id' }] }),
    async () => {
      const result = await fetchCustomModels(config);
      assertEquals(result.data.length, 1);
      assertEquals(result.data[0].id, 'ok');
    },
  );
});

test('fetchCustomModels throws ProviderModelsUnavailableError with httpResponse on non-2xx', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  let thrown: unknown;
  await withMockedFetch(
    () => new Response('rate limit', { status: 429, headers: { 'retry-after': '5' } }),
    async () => {
      try { await fetchCustomModels(config); } catch (e) { thrown = e; }
    },
  );
  if (!(thrown instanceof ProviderModelsUnavailableError)) throw new Error('expected ProviderModelsUnavailableError');
  assertEquals(thrown.httpResponse?.status, 429);
  assertEquals(thrown.httpResponse?.body, 'rate limit');
  assertEquals(thrown.httpResponse?.headers.get('retry-after'), '5');
  assertEquals(isProviderModelsHttpStatus(thrown, 429), true);
  assertEquals(isProviderModelsHttpStatus(thrown, 500), false);
});

test('fetchCustomModels throws ProviderModelsUnavailableError with null httpResponse on network error', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  let thrown: unknown;
  await withMockedFetch(
    () => { throw new TypeError('network down'); },
    async () => {
      try { await fetchCustomModels(config); } catch (e) { thrown = e; }
    },
  );
  if (!(thrown instanceof ProviderModelsUnavailableError)) throw new Error('expected ProviderModelsUnavailableError');
  assertEquals(thrown.httpResponse, null);
  assertEquals(isProviderModelsHttpStatus(thrown, 429), false);
});

test('fetchCustomModels throws ProviderModelsUnavailableError with null httpResponse on shape error', async () => {
  const { config } = assertCustomUpstreamRecord(upstreamRecord());
  let thrown: unknown;
  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: 'oops' }),
    async () => {
      try { await fetchCustomModels(config); } catch (e) { thrown = e; }
    },
  );
  if (!(thrown instanceof ProviderModelsUnavailableError)) throw new Error('expected ProviderModelsUnavailableError');
  assertEquals(thrown.httpResponse, null);
});
