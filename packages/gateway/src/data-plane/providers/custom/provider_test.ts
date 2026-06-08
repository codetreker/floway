import { test } from 'vitest';

import { buildCustomUpstreamRecord, setupAppTest } from '../../../test-helpers.ts';
import { clearModelsStore, ProviderModelsUnavailableError } from '@floway-dev/provider';
import type { UpstreamRecord } from '@floway-dev/provider';
import { createCustomProvider } from '@floway-dev/provider-custom';
import { jsonResponse, sseResponse, withMockedFetch, assertEquals, assertExists } from '@floway-dev/test-utils';

const baseRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_custom_test',
  provider: 'custom',
  name: 'Custom Test',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  config: {
    baseUrl: 'https://custom.example.com',
    bearerToken: 'sk-test',
    endpoints: { chatCompletions: {}, responses: {}, messages: {} },
  },
  state: null,
  ...overrides,
});

test('Custom provider forces stream=true for streaming endpoints and leaves count-tokens/embeddings alone', async () => {
  const instance = createCustomProvider(baseRecord());
  const provider = instance.provider;
  const bodies: Record<string, Record<string, unknown>> = {};

  assertEquals(instance.supportsResponsesItemReference, true);

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'echo', object: 'model' }],
        });
      }

      bodies[path] = (await request.json()) as Record<string, unknown>;

      if (path === '/v1/chat/completions') {
        return sseResponse();
      }
      if (path === '/v1/responses') {
        return sseResponse();
      }
      if (path === '/v1/messages') {
        return sseResponse();
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

test('Custom provider uses configured endpoints regardless of per-model hints in the /models response', async () => {
  await setupAppTest();
  clearModelsStore();

  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      data: [{ id: 'm-1', supported_endpoints: ['/some/random/path'] }],
    }),
    async () => {
      const provider = createCustomProvider(baseRecord({
        id: 'up_custom_endpoints',
        config: {
          baseUrl: 'https://custom.example.com',
          bearerToken: 'sk-test',
          endpoints: { chatCompletions: {} },
        },
      })).provider;
      const [model] = await provider.getProvidedModels();
      assertEquals(model.endpoints, { chatCompletions: {} });
      assertEquals(model.kind, 'chat');
    },
  );
});

test('Custom provider projects display_name / created / limits / cost from a floway-style /models response', async () => {
  await setupAppTest();
  clearModelsStore();

  await withMockedFetch(
    () => jsonResponse({
      object: 'list',
      data: [{
        id: 'm-rich',
        type: 'model',
        display_name: 'Rich Model',
        created_at: '2026-04-01T00:00:00Z',
        limits: { max_output_tokens: 8192, max_context_window_tokens: 200000 },
        cost: { input: 3, output: 15, input_cache_read: 0.3 },
      }],
    }),
    async () => {
      const instance = createCustomProvider(baseRecord({ id: 'up_custom_rich' }));
      const [model] = await instance.provider.getProvidedModels();
      assertEquals(model.display_name, 'Rich Model');
      // 2026-04-01T00:00:00Z → 1774569600
      assertEquals(model.created, Math.floor(Date.parse('2026-04-01T00:00:00Z') / 1000));
      assertEquals(model.limits.max_output_tokens, 8192);
      assertEquals(model.limits.max_context_window_tokens, 200000);
      assertEquals(model.cost?.input, 3);
      assertEquals(model.cost?.output, 15);
      assertEquals(model.cost?.input_cache_read, 0.3);

      const pricing = instance.provider.getPricingForModelKey('m-rich');
      assertEquals(pricing?.input, 3);
      assertEquals(pricing?.output, 15);

      assertEquals(instance.provider.getPricingForModelKey('unknown'), null);
    },
  );
});

test('Custom provider falls back to `name` when display_name is missing (loose OpenAI-compat upstreams)', async () => {
  await setupAppTest();
  clearModelsStore();

  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'm-named', name: 'Named Model' }] }),
    async () => {
      const [model] = await createCustomProvider(baseRecord({ id: 'up_custom_named' })).provider.getProvidedModels();
      assertEquals(model.display_name, 'Named Model');
    },
  );
});

test('Custom provider projects gpt-image-* models with kind=image and both image endpoints', async () => {
  await setupAppTest();
  clearModelsStore();
  const record = buildCustomUpstreamRecord({
    config: { baseUrl: 'https://custom.example.com', bearerToken: 'sk-custom', endpoints: { chatCompletions: {} } },
  });
  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/models') {
        return jsonResponse({ data: [{ id: 'gpt-image-2-2026-04-21' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const provider = createCustomProvider(record).provider;
      const models = await provider.getProvidedModels();
      assertEquals(models.length, 1);
      assertEquals(models[0].id, 'gpt-image-2-2026-04-21');
      assertEquals(models[0].kind, 'image');
      assertEquals(models[0].endpoints, { imagesGenerations: {}, imagesEdits: {} });
    },
  );
});

test('Custom provider callImagesGenerations posts JSON with model re-injected', async () => {
  await setupAppTest();
  clearModelsStore();
  const record = buildCustomUpstreamRecord({
    config: { baseUrl: 'https://custom.example.com', bearerToken: 'sk-custom', endpoints: { chatCompletions: {} } },
  });
  let forwarded: { url: string; body: { model?: unknown; prompt?: unknown } } | undefined;
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/models') return jsonResponse({ data: [{ id: 'gpt-image-2' }] });
      if (url.pathname === '/v1/images/generations') {
        forwarded = { url: request.url, body: await request.json() as Record<string, unknown> };
        return jsonResponse({ data: [{ b64_json: 'abc' }], usage: { input_tokens: 10, output_tokens: 50 } });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const provider = createCustomProvider(record).provider;
      const models = await provider.getProvidedModels();
      const result = await provider.callImagesGenerations(models[0], { prompt: 'hi' });
      assertEquals(result.modelKey, 'gpt-image-2');
      assertEquals(result.response.status, 200);
    },
  );
  assertExists(forwarded);
  assertEquals(forwarded.body.model, 'gpt-image-2');
  assertEquals(forwarded.body.prompt, 'hi');
});

test('Custom provider callImagesEdits forwards multipart body with model field appended', async () => {
  await setupAppTest();
  clearModelsStore();
  const record = buildCustomUpstreamRecord({
    config: { baseUrl: 'https://custom.example.com', bearerToken: 'sk-custom', endpoints: { chatCompletions: {} } },
  });
  let forwarded: { url: string; form: FormData } | undefined;
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/models') return jsonResponse({ data: [{ id: 'gpt-image-2' }] });
      if (url.pathname === '/v1/images/edits') {
        forwarded = { url: request.url, form: await request.formData() };
        return jsonResponse({ data: [{ b64_json: 'abc' }], usage: { input_tokens: 5, output_tokens: 20 } });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const provider = createCustomProvider(record).provider;
      const models = await provider.getProvidedModels();
      const form = new FormData();
      form.append('prompt', 'add a kite');
      form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'photo.png');
      const result = await provider.callImagesEdits(models[0], form);
      assertEquals(result.modelKey, 'gpt-image-2');
      assertEquals(result.response.status, 200);
    },
  );
  assertExists(forwarded);
  assertEquals(forwarded.form.get('model'), 'gpt-image-2');
  assertEquals(forwarded.form.get('prompt'), 'add a kite');
  assertEquals(forwarded.form.get('image') instanceof File, true);
});

test('Custom provider with modelsFetch disabled serves only manual models and never fetches', async () => {
  await setupAppTest();
  clearModelsStore();

  await withMockedFetch(
    () => { throw new Error('upstream /models must not be fetched when modelsFetch is disabled'); },
    async () => {
      const provider = createCustomProvider(baseRecord({
        id: 'up_custom_manual_only',
        config: {
          baseUrl: 'https://custom.example.com',
          bearerToken: 'sk-test',
          endpoints: { chatCompletions: {} },
          modelsFetch: { enabled: false },
          models: [
            {
              upstreamModelId: 'pinned-chat',
              publicModelId: 'pinned',
              endpoints: { chatCompletions: {} },
              display_name: 'Pinned Chat',
              limits: { max_output_tokens: 4096 },
              cost: { input: 1, output: 2 },
            },
          ],
        },
      })).provider;

      const models = await provider.getProvidedModels();
      assertEquals(models.length, 1);
      assertEquals(models[0].id, 'pinned');
      assertEquals(models[0].kind, 'chat');
      assertEquals(models[0].endpoints, { chatCompletions: {} });
      assertEquals(models[0].display_name, 'Pinned Chat');
      assertEquals(models[0].limits.max_output_tokens, 4096);
      assertEquals(models[0].cost?.input, 1);

      const pricing = provider.getPricingForModelKey('pinned-chat');
      assertEquals(pricing?.input, 1);
      assertEquals(pricing?.output, 2);
    },
  );
});

test('Custom provider with a manual override sharing an upstream id wins over the auto copy', async () => {
  await setupAppTest();
  clearModelsStore();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [
            { id: 'shared', cost: { input: 9, output: 9 } },
            { id: 'auto-only' },
          ],
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const provider = createCustomProvider(baseRecord({
        id: 'up_custom_override',
        config: {
          baseUrl: 'https://custom.example.com',
          bearerToken: 'sk-test',
          endpoints: { chatCompletions: {} },
          modelsFetch: { enabled: true },
          models: [
            {
              upstreamModelId: 'shared',
              endpoints: { chatCompletions: {} },
              display_name: 'Manual Shared',
              cost: { input: 1, output: 2 },
            },
          ],
        },
      })).provider;

      const models = await provider.getProvidedModels();
      // [manual, ...autoFiltered] — the upstream 'shared' copy is dropped.
      assertEquals(models.map(m => m.id), ['shared', 'auto-only']);
      const shared = models.find(m => m.id === 'shared');
      assertExists(shared);
      assertEquals(shared.display_name, 'Manual Shared');

      // Pricing resolves from the manual config first, not the cached upstream cost.
      const sharedPricing = provider.getPricingForModelKey('shared');
      assertEquals(sharedPricing?.input, 1);
      assertEquals(sharedPricing?.output, 2);

      // Auto models still resolve pricing from the cached upstream map.
      const autoOnly = provider.getPricingForModelKey('auto-only');
      assertEquals(autoOnly, null);
    },
  );
});

test('Custom provider forwards the source-derived anthropicBeta slice as the anthropic-beta header', async () => {
  const instance = createCustomProvider(baseRecord());
  const provider = instance.provider;
  const seen: Array<string | null> = [];

  await withMockedFetch(
    request => {
      const path = new URL(request.url).pathname;
      if (path === '/v1/models') return jsonResponse({ object: 'list', data: [{ id: 'echo', object: 'model' }] });
      seen.push(request.headers.get('anthropic-beta'));
      if (path === '/v1/messages') return sseResponse();
      if (path === '/v1/messages/count_tokens') return jsonResponse({ input_tokens: 1 });
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await provider.getProvidedModels();
      // The data plane hands the parsed beta slice as the 5th argument; custom
      // upstreams register no filter interceptor, so the provider merges it.
      await provider.callMessages(model, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, undefined, {}, ['oauth-2025-04-20', 'interleaved-thinking-2025-05-14']);
      await provider.callMessagesCountTokens(model, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, undefined, {}, ['oauth-2025-04-20']);
      // No beta slice → no header on the wire (the regression guard for the
      // pre-86ef9aa drop).
      await provider.callMessages(model, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, undefined, {}, []);
      await provider.callMessages(model, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    },
  );

  assertEquals(seen, ['oauth-2025-04-20,interleaved-thinking-2025-05-14', 'oauth-2025-04-20', null, null]);
});
