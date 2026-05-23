import { test } from 'vitest';

import { createCustomProvider } from './provider.ts';
import type { UpstreamRecord } from '../../../repo/types.ts';
import { assertEquals } from '../../../test-assert.ts';
import { jsonResponse, setupAppTest, withMockedFetch } from '../../../test-helpers.ts';
import { clearModelsStore, ProviderModelsUnavailableError } from '../models-store.ts';

const baseRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_custom_test',
  provider: 'custom',
  name: 'Custom Test',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  flagOverrides: {},
  config: {
    baseUrl: 'https://custom.example.com',
    bearerToken: 'sk-test',
    supportedEndpoints: ['/chat/completions', '/responses', '/v1/messages', '/embeddings'],
  },
  ...overrides,
});

test('Custom provider forces stream=true for streaming endpoints and leaves count-tokens/embeddings alone', async () => {
  const instance = createCustomProvider(baseRecord());
  const provider = instance.provider;
  const bodies: Record<string, Record<string, unknown>> = {};

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'echo', object: 'model', supported_endpoints: ['/chat/completions', '/responses', '/v1/messages', '/v1/messages/count_tokens', '/embeddings'] }],
        });
      }

      bodies[path] = (await request.json()) as Record<string, unknown>;

      if (path === '/v1/chat/completions') {
        return jsonResponse({ id: 'cc', object: 'chat.completion', model: 'echo', choices: [], usage: {} });
      }
      if (path === '/v1/responses') {
        return jsonResponse({ id: 'r', object: 'response', model: 'echo', output: [], usage: {} });
      }
      if (path === '/v1/messages') {
        return jsonResponse({ id: 'm', type: 'message', role: 'assistant', content: [], model: 'echo', stop_reason: 'end_turn', stop_sequence: null, usage: {} });
      }
      if (path === '/v1/messages/count_tokens') {
        return jsonResponse({ input_tokens: 1 });
      }
      if (path === '/v1/embeddings') {
        return jsonResponse({ object: 'list', data: [], model: 'echo' });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await provider.getProvidedModels();
      assertEquals(model.id, 'echo');

      await provider.callChatCompletions(model, { messages: [{ role: 'user', content: 'hi' }] });
      await provider.callResponses(model, { input: [] });
      await provider.callMessages(model, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      await provider.callMessagesCountTokens(model, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      await provider.callEmbeddings(model, { input: 'hi' });
    },
  );

  assertEquals(bodies['/v1/chat/completions'].stream, true);
  assertEquals(bodies['/v1/responses'].stream, true);
  assertEquals(bodies['/v1/messages'].stream, true);
  assertEquals('stream' in bodies['/v1/messages/count_tokens'], false);
  assertEquals('stream' in bodies['/v1/embeddings'], false);
});

const withMutableNow = async <T>(initial: number, run: (setNow: (value: number) => void) => Promise<T>): Promise<T> => {
  const originalNow = Date.now;
  let now = initial;
  Date.now = () => now;
  try {
    return await run(value => { now = value; });
  } finally {
    Date.now = originalNow;
  }
};

test('Custom provider serves from L2 within the 10 min soft window', async () => {
  await setupAppTest();
  clearModelsStore();

  let fetches = 0;
  await withMockedFetch(
    () => { fetches++; return jsonResponse({ object: 'list', data: [{ id: `m-${fetches}` }] }); },
    async () => {
      const provider = createCustomProvider(baseRecord({ id: 'up_custom_cache' })).provider;
      await withMutableNow(1_000_000, async setNow => {
        const first = await provider.getProvidedModels();
        assertEquals(first[0].id, 'm-1');
        setNow(1_000_000 + 5 * 60_000);
        // 5 min exceeds L1 TTL so the second call re-enters the inner closure and serves from L2.
        const second = await provider.getProvidedModels();
        assertEquals(second[0].id, 'm-1');
      });
    },
  );
  assertEquals(fetches, 1);
});

test('Custom provider re-fetches after the 10 min soft window', async () => {
  await setupAppTest();
  clearModelsStore();

  let fetches = 0;
  await withMockedFetch(
    () => { fetches++; return jsonResponse({ object: 'list', data: [{ id: `m-${fetches}` }] }); },
    async () => {
      const provider = createCustomProvider(baseRecord({ id: 'up_custom_cache' })).provider;
      await withMutableNow(1_000_000, async setNow => {
        const first = await provider.getProvidedModels();
        assertEquals(first[0].id, 'm-1');
        setNow(1_000_000 + 11 * 60_000);
        clearModelsStore(); // drop L1 so we exercise L2 expiry
        const second = await provider.getProvidedModels();
        assertEquals(second[0].id, 'm-2');
      });
    },
  );
  assertEquals(fetches, 2);
});

test('Custom provider reuses stale L2 on 429 within hard window', async () => {
  await setupAppTest();
  clearModelsStore();

  let fetches = 0;
  await withMockedFetch(
    () => {
      fetches++;
      if (fetches === 1) return jsonResponse({ object: 'list', data: [{ id: 'stable' }] });
      return new Response('rate limit', { status: 429 });
    },
    async () => {
      const provider = createCustomProvider(baseRecord({ id: 'up_custom_cache' })).provider;
      await withMutableNow(1_000_000, async setNow => {
        const fresh = await provider.getProvidedModels();
        assertEquals(fresh[0].id, 'stable');
        setNow(1_000_000 + 30 * 60_000);
        clearModelsStore();
        const stale = await provider.getProvidedModels();
        assertEquals(stale[0].id, 'stable');
      });
    },
  );
  assertEquals(fetches, 2);
});

test('Custom provider throws ProviderModelsUnavailableError when fetch fails beyond hard window', async () => {
  await setupAppTest();
  clearModelsStore();

  let fetches = 0;
  let thrown: unknown;
  await withMockedFetch(
    () => {
      fetches++;
      if (fetches === 1) return jsonResponse({ object: 'list', data: [{ id: 'stable' }] });
      return new Response('rate limit', { status: 429 });
    },
    async () => {
      const provider = createCustomProvider(baseRecord({ id: 'up_custom_cache' })).provider;
      await withMutableNow(1_000_000, async setNow => {
        await provider.getProvidedModels();
        setNow(1_000_000 + 3 * 60 * 60_000); // beyond 2h hard window
        clearModelsStore();
        try { await provider.getProvidedModels(); } catch (e) { thrown = e; }
      });
    },
  );
  if (!(thrown instanceof ProviderModelsUnavailableError)) throw new Error('expected ProviderModelsUnavailableError');
  assertEquals(thrown.httpResponse?.status, 429);
});
