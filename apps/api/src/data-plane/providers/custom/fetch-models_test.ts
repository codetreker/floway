import { test } from 'vitest';

import { fetchCustomModels } from './fetch-models.ts';
import { createCustomUpstream } from '../../../shared/upstream/custom.ts';
import { assertEquals } from '../../../test-assert.ts';
import { jsonResponse, withMockedFetch } from '../../../test-helpers.ts';
import { isProviderModelsHttpStatus, ProviderModelsUnavailableError } from '../models-store.ts';

const upstreamRecord = () => ({
  id: 'up_custom',
  provider: 'custom' as const,
  name: 'Custom',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  flagOverrides: {},
  config: {
    baseUrl: 'https://custom.example.com',
    bearerToken: 'token',
    supportedEndpoints: ['/v1/chat/completions'],
  },
});

test('fetchCustomModels returns the parsed response on 2xx', async () => {
  const upstream = createCustomUpstream(upstreamRecord());
  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'm-1' }] }),
    async () => {
      const result = await fetchCustomModels(upstream);
      assertEquals(result.data[0].id, 'm-1');
    },
  );
});

test('fetchCustomModels throws ProviderModelsUnavailableError with httpResponse on non-2xx', async () => {
  const upstream = createCustomUpstream(upstreamRecord());
  let thrown: unknown;
  await withMockedFetch(
    () => new Response('rate limit', { status: 429, headers: { 'retry-after': '5' } }),
    async () => {
      try { await fetchCustomModels(upstream); } catch (e) { thrown = e; }
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
  const upstream = createCustomUpstream(upstreamRecord());
  let thrown: unknown;
  await withMockedFetch(
    () => { throw new TypeError('network down'); },
    async () => {
      try { await fetchCustomModels(upstream); } catch (e) { thrown = e; }
    },
  );
  if (!(thrown instanceof ProviderModelsUnavailableError)) throw new Error('expected ProviderModelsUnavailableError');
  assertEquals(thrown.httpResponse, null);
  assertEquals(isProviderModelsHttpStatus(thrown, 429), false);
});

test('fetchCustomModels throws ProviderModelsUnavailableError with null httpResponse on shape error', async () => {
  const upstream = createCustomUpstream(upstreamRecord());
  let thrown: unknown;
  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 123 }] }),
    async () => {
      try { await fetchCustomModels(upstream); } catch (e) { thrown = e; }
    },
  );
  if (!(thrown instanceof ProviderModelsUnavailableError)) throw new Error('expected ProviderModelsUnavailableError');
  assertEquals(thrown.httpResponse, null);
});
