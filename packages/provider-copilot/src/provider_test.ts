import { test } from 'vitest';

import { clearCopilotTokenCache } from './auth.ts';
import { createCopilotProvider } from './provider.ts';
import { createInMemoryImageProcessor, initImageProcessor } from '@floway-dev/platform';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { UpstreamRecord } from '@floway-dev/provider';
import { clearModelsStore, initProviderRepo, ProviderModelsUnavailableError } from '@floway-dev/provider';
import { assertEquals, assertRejects, jsonResponse, memoryCacheRepo, sseResponse, withMockedFetch } from '@floway-dev/test-utils';

const buildCopilotUpstream = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => {
  const { config: overrideConfig, ...rest } = overrides;
  return {
    id: 'up_copilot',
    provider: 'copilot',
    name: 'GitHub Copilot (tester)',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-03-15T00:00:00.000Z',
    updatedAt: '2026-03-15T00:00:00.000Z',
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    ...rest,
    config: overrideConfig ?? {
      githubToken: `ghu_${crypto.randomUUID().replace(/-/g, '')}`,
      accountType: 'individual',
      user: { id: 1, login: 'tester', name: 'Test User', avatar_url: 'https://example.com/avatar.png' },
    },
  };
};

const setupCopilotTest = async (): Promise<{ copilotUpstream: UpstreamRecord }> => {
  const cache = memoryCacheRepo();
  initProviderRepo(() => ({
    cache,
    upstreams: {
      getById: async () => null,
      saveState: async () => ({ updated: false }),
    },
  }));
  initImageProcessor(createInMemoryImageProcessor());
  await clearCopilotTokenCache();
  clearModelsStore();
  return { copilotUpstream: buildCopilotUpstream() };
};

interface CopilotModelFixture {
  id: string;
  display_name?: string;
  supported_endpoints?: string[];
  reasoningEfforts?: string[];
  maxContextWindowTokens?: number;
  maxPromptTokens?: number;
  maxOutputTokens?: number;
}

const copilotModels = (models: CopilotModelFixture[]) => ({
  object: 'list',
  data: models.map(model => ({
    id: model.id,
    name: model.id,
    ...(model.display_name !== undefined ? { display_name: model.display_name } : {}),
    version: '1',
    supported_endpoints: model.supported_endpoints ?? [],
    capabilities: {
      type: 'chat',
      limits: {
        ...(model.maxContextWindowTokens !== undefined ? { max_context_window_tokens: model.maxContextWindowTokens } : {}),
        ...(model.maxPromptTokens !== undefined ? { max_prompt_tokens: model.maxPromptTokens } : {}),
        ...(model.maxOutputTokens !== undefined ? { max_output_tokens: model.maxOutputTokens } : {}),
      },
      ...(model.reasoningEfforts !== undefined ? { supports: { reasoning_effort: model.reasoningEfforts } } : {}),
    },
  })),
});

test('Copilot provider exposes the highest-priority non-Claude endpoint', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const instance = await createCopilotProvider(copilotUpstream);
  const provider = instance.provider;

  assertEquals(instance.supportsResponsesItemReference, false);

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            {
              id: 'gpt-dual',
              supported_endpoints: ['/responses', '/chat/completions', '/v1/messages'],
            },
          ]),
        );
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const models = await provider.getProvidedModels();

      assertEquals(
        models.map(model => model.id),
        ['gpt-dual'],
      );
      assertEquals(models[0].endpoints, { responses: {} });
    },
  );
});

test('Copilot provider exposes only Responses for Claude when available', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const instance = await createCopilotProvider(copilotUpstream);
  const provider = instance.provider;

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            {
              id: 'claude-opus-4.7',
              display_name: 'Claude Opus 4.7',
              supported_endpoints: ['/responses', '/chat/completions'],
            },
            {
              id: 'claude-opus-4.7-xhigh',
              supported_endpoints: ['/v1/messages'],
              reasoningEfforts: ['xhigh'],
            },
          ]),
        );
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await provider.getProvidedModels();

      assertEquals(model.id, 'claude-opus-4-7');
      assertEquals(model.display_name, 'Claude Opus 4.7');
      assertEquals(model.endpoints, { responses: {} });
    },
  );
});

test('Copilot provider owns the claude-* Messages capability workaround', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const instance = await createCopilotProvider(copilotUpstream);
  const provider = instance.provider;
  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            {
              id: 'claude-haiku-chat-listed',
              supported_endpoints: ['/chat/completions'],
            },
          ]),
        );
      }
      if (url.pathname === '/v1/messages') {
        upstreamBody = (await request.json()) as Record<string, unknown>;
        return sseResponse();
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await provider.getProvidedModels();

      assertEquals(model.id, 'claude-haiku-chat-listed');
      assertEquals(model.endpoints, { messages: {} });

      await provider.callMessages(model, {
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hello' }],
      });
    },
  );

  assertEquals(upstreamBody?.model, 'claude-haiku-chat-listed');
});

test('Copilot provider selects raw variants that support the target endpoint', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const instance = await createCopilotProvider(copilotUpstream);
  const provider = instance.provider;
  let responsesBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            {
              id: 'claude-opus-4.7',
              supported_endpoints: ['/responses'],
              reasoningEfforts: ['medium'],
            },
            {
              id: 'claude-opus-4.7-xhigh',
              supported_endpoints: ['/v1/messages'],
              reasoningEfforts: ['xhigh'],
            },
          ]),
        );
      }
      if (url.pathname === '/responses') {
        responsesBody = (await request.json()) as Record<string, unknown>;
        return sseResponse();
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await provider.getProvidedModels();
      await provider.callResponses(model, {
        input: [],
        reasoning: { effort: 'xhigh' },
      });
    },
  );

  assertEquals(responsesBody?.model, 'claude-opus-4.7');
});

test('Copilot provider runs the Responses boundary chain on the compact path', async () => {
  // The compact-path boundary registers payload mutators (force-store-false,
  // strip-service-tier, strip-image-generation, ...) plus header derivers
  // (set-vision-header, set-initiator-header). Driving callResponsesCompact
  // through a real upstream stub exercises the integration end-to-end: the
  // payload mutators reach the wire body, the header derivers reach the wire
  // request headers, and the compact-shaped envelope still comes back through
  // `compactionResponse`.
  const { copilotUpstream } = await setupCopilotTest();
  const instance = await createCopilotProvider(copilotUpstream);
  const provider = instance.provider;
  let responsesBody: Record<string, unknown> | undefined;
  let visionHeader: string | null = null;
  let initiatorHeader: string | null = null;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600 });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-resp', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        responsesBody = (await request.json()) as Record<string, unknown>;
        visionHeader = request.headers.get('copilot-vision-request');
        initiatorHeader = request.headers.get('x-initiator');
        return jsonResponse({
          id: 'resp_test',
          object: 'response',
          model: 'gpt-resp',
          status: 'completed',
          output: [{ type: 'compaction', summary: 'compacted state' }],
          incomplete_details: null,
          error: null,
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await provider.getProvidedModels();
      // service_tier is set so withServiceTierStripped has something to strip;
      // an input_image is included so withVisionHeaderSet fires; the last
      // input item is a user message so withInitiatorHeaderSet picks 'user'.
      const result = await provider.callResponsesCompact(model, {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'compact me' },
              { type: 'input_image', image_url: 'https://example.com/x.png', detail: 'auto' },
            ],
          },
        ],
        service_tier: 'priority',
      });

      if (!result.ok) throw new Error('expected ok compaction result');
      assertEquals(result.result.object, 'response.compaction');
    },
  );

  // withStoreForcedFalse reached the wire body.
  assertEquals(responsesBody?.store, false);
  // withServiceTierStripped removed the field from the wire body.
  assertEquals('service_tier' in (responsesBody ?? {}), false);
  // The compaction trigger item was still appended to input.
  const wireInput = responsesBody?.input as Array<{ type: string }>;
  assertEquals(wireInput.at(-1)?.type, 'compaction_trigger');
  // withVisionHeaderSet detected the input_image and set the Copilot vision
  // header on the upstream request.
  assertEquals(visionHeader, 'true');
  // withInitiatorHeaderSet classified the last input item (a user message) as
  // user-initiated.
  assertEquals(initiatorHeader, 'user');
});

test('Copilot provider exposes its default flag set via UpstreamModel.enabledFlags', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const instance = await createCopilotProvider({
    ...copilotUpstream,
    flagOverrides: { 'messages-web-search-shim': true },
    disabledPublicModelIds: [],
  });

  assertEquals(instance.upstream, 'up_copilot');
  assertEquals(instance.name, copilotUpstream.name);

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-test', supported_endpoints: ['/chat/completions'] }]));
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const models = await instance.provider.getProvidedModels();
      const model = models[0];
      if (!model) throw new Error('expected at least one Copilot model in test fixture');
      assertEquals(model.enabledFlags.has('retry-cyber-policy'), true);
      assertEquals(model.enabledFlags.has('messages-web-search-shim'), true);
    },
  );
});

test('Copilot provider rejects malformed account type instead of falling back', async () => {
  const { copilotUpstream } = await setupCopilotTest();

  await assertRejects(
    () =>
      createCopilotProvider({
        ...copilotUpstream,
        config: {
          ...(copilotUpstream.config as Record<string, unknown>),
          accountType: 'toString',
        },
      }),
    Error,
    'accountType must be one of individual, business, enterprise',
  );
});

test('Copilot provider forces stream=true for streaming endpoints and leaves count-tokens/embeddings alone', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const instance = await createCopilotProvider(copilotUpstream);
  const provider = instance.provider;
  const bodies: Record<string, Record<string, unknown>> = {};

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            { id: 'gpt-chat', supported_endpoints: ['/chat/completions'] },
            { id: 'gpt-resp', supported_endpoints: ['/responses'] },
            { id: 'claude-msg', supported_endpoints: ['/v1/messages'] },
            { id: 'emb-mini', supported_endpoints: ['/embeddings'] },
          ]),
        );
      }

      const path = url.pathname;
      bodies[path] = (await request.json()) as Record<string, unknown>;

      if (path === '/chat/completions') {
        return sseResponse();
      }
      if (path === '/responses') {
        return sseResponse();
      }
      if (path === '/v1/messages') {
        return sseResponse();
      }
      if (path === '/v1/messages/count_tokens') {
        return jsonResponse({ input_tokens: 1 });
      }
      if (path === '/embeddings') {
        return jsonResponse({ object: 'list', data: [], model: 'emb-mini' });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const models = await provider.getProvidedModels();
      const byId = new Map(models.map(model => [model.id, model]));

      await provider.callChatCompletions(byId.get('gpt-chat')!, { messages: [{ role: 'user', content: 'hi' }] });
      await provider.callResponses(byId.get('gpt-resp')!, { input: [] });
      await provider.callMessages(byId.get('claude-msg')!, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      await provider.callMessagesCountTokens(byId.get('claude-msg')!, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      await provider.callEmbeddings(byId.get('emb-mini')!, { input: 'hi' });
    },
  );

  assertEquals(bodies['/chat/completions'].stream, true);
  assertEquals(bodies['/responses'].stream, true);
  assertEquals(bodies['/v1/messages'].stream, true);
  assertEquals('stream' in bodies['/v1/messages/count_tokens'], false);
  assertEquals('stream' in bodies['/embeddings'], false);
});

test('Copilot provider sets copilot-vision-request when an image is nested inside tool_result.content', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const instance = await createCopilotProvider(copilotUpstream);
  const provider = instance.provider;
  const visionHeaders: string[] = [];

  // The boundary chain runs inside `provider.callMessages` itself, so this
  // exercises the integration contract end-to-end: the vision-detection
  // interceptor reads the payload, sets the header in the boundary header
  // bag, and the upstream sees it.
  const driveMessages = async (model: Awaited<ReturnType<typeof instance.provider.getProvidedModels>>[number], body: Omit<MessagesPayload, 'model'>): Promise<void> => {
    await provider.callMessages(model, body);
  };

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-msg', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.pathname === '/v1/messages') {
        visionHeaders.push(request.headers.get('copilot-vision-request') ?? '');
        await request.text();
        return sseResponse();
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await provider.getProvidedModels();

      // Tool result carrying an image — the only image in the conversation
      // lives nested inside `tool_result.content`, so the vision detector must
      // recurse into tool_result.content to discover it.
      await driveMessages(model, {
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_image',
                content: [
                  {
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
                  },
                ],
              },
            ],
          },
        ],
      });

      // No image anywhere — header must not be set.
      await driveMessages(model, {
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_text',
                content: [{ type: 'text', text: 'plain result' }],
              },
            ],
          },
        ],
      });
    },
  );

  assertEquals(visionHeaders, ['true', '']);
});

test('Copilot Messages boundary chain does NOT fire on the Chat Completions wire (translated path)', async () => {
  // Boundary isolation: each provider call method runs only its own protocol
  // boundary chain. The Messages-only `withClaudeAgentHeadersSet` interceptor
  // would set x-interaction-type to 'messages-proxy' for Claude Code SDK
  // metadata, but it MUST NOT run when the translated path calls Copilot's
  // chat-completions wire — that path runs `COPILOT_CHATCOMPLETIONS_BOUNDARY`,
  // which has no Messages-source headers in it.
  const { copilotUpstream } = await setupCopilotTest();
  const instance = await createCopilotProvider(copilotUpstream);
  const provider = instance.provider;
  const observedInteractionType: (string | null)[] = [];

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600 });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-chat', supported_endpoints: ['/chat/completions'] }]));
      }
      if (url.pathname === '/chat/completions') {
        observedInteractionType.push(request.headers.get('x-interaction-type'));
        await request.text();
        return sseResponse();
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await provider.getProvidedModels();
      // Even with a Claude-Code-shaped metadata blob, the chat-completions
      // boundary chain has no Messages-source interceptor, so the
      // messages-proxy intent must not appear on the wire.
      await provider.callChatCompletions(model, {
        messages: [{ role: 'user', content: 'hi' }],
        metadata: { user_id: JSON.stringify({ device_id: 'dev-1', session_id: 'sess-1' }) },
      });
    },
  );

  // The chat-completions wire defaults to `conversation-agent`
  // (set by copilotFetch). The Messages-boundary `withClaudeAgentHeadersSet`
  // would overwrite it to `messages-proxy` if it had run — its absence is the
  // proof that the Messages boundary chain did NOT fire on this wire.
  assertEquals(observedInteractionType, ['conversation-agent']);
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

const copilotPreflight = (request: Request): Response | null => {
  const url = new URL(request.url);
  if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
  if (url.pathname === '/copilot_internal/v2/token') {
    return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600 });
  }
  return null;
};

test('Copilot provider keeps a model in the ledger for 24 h even when the next fetch omits it', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  clearModelsStore();

  let fetches = 0;
  await withMockedFetch(
    request => {
      const pre = copilotPreflight(request);
      if (pre) return pre;
      const url = new URL(request.url);
      if (url.pathname === '/models') {
        fetches++;
        const data = fetches === 1
          ? [{ id: 'a', supported_endpoints: ['/v1/messages'] }, { id: 'b', supported_endpoints: ['/v1/messages'] }]
          : [{ id: 'a', supported_endpoints: ['/v1/messages'] }];
        return jsonResponse({ object: 'list', data });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const instance = await createCopilotProvider(copilotUpstream);
      await withMutableNow(1_000_000, async setNow => {
        const first = await instance.provider.getProvidedModels();
        assertEquals(first.map(m => m.id).sort(), ['a', 'b']);
        setNow(1_000_000 + 11 * 60_000); // past soft window so we re-fetch
        clearModelsStore();
        const second = await instance.provider.getProvidedModels();
        assertEquals(second.map(m => m.id).sort(), ['a', 'b'], 'b should still appear from the ledger');
      });
    },
  );
  assertEquals(fetches, 2);
});

test('Copilot provider drops a model after 24 h of continuous absence', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  clearModelsStore();

  let fetches = 0;
  await withMockedFetch(
    request => {
      const pre = copilotPreflight(request);
      if (pre) return pre;
      const url = new URL(request.url);
      if (url.pathname === '/models') {
        fetches++;
        const data = fetches === 1
          ? [{ id: 'a', supported_endpoints: ['/v1/messages'] }, { id: 'b', supported_endpoints: ['/v1/messages'] }]
          : [{ id: 'a', supported_endpoints: ['/v1/messages'] }];
        return jsonResponse({ object: 'list', data });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const instance = await createCopilotProvider(copilotUpstream);
      await withMutableNow(1_000_000, async setNow => {
        await instance.provider.getProvidedModels();
        setNow(1_000_000 + 25 * 60 * 60_000); // 25h after first fetch
        clearModelsStore();
        const after = await instance.provider.getProvidedModels();
        assertEquals(after.map(m => m.id), ['a']);
      });
    },
  );
  assertEquals(fetches, 2);
});

test('Copilot provider returns ledger projection when fetch fails but ledger is non-empty', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  clearModelsStore();

  let fetches = 0;
  await withMockedFetch(
    request => {
      const pre = copilotPreflight(request);
      if (pre) return pre;
      const url = new URL(request.url);
      if (url.pathname === '/models') {
        fetches++;
        if (fetches === 1) return jsonResponse({ object: 'list', data: [{ id: 'a', supported_endpoints: ['/v1/messages'] }] });
        return new Response('unavailable', { status: 503 });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const instance = await createCopilotProvider(copilotUpstream);
      await withMutableNow(1_000_000, async setNow => {
        await instance.provider.getProvidedModels();
        setNow(1_000_000 + 11 * 60_000);
        clearModelsStore();
        const after = await instance.provider.getProvidedModels();
        assertEquals(after.map(m => m.id), ['a']);
      });
    },
  );
});

test('Copilot provider throws ProviderModelsUnavailableError when ledger is empty and fetch fails', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  clearModelsStore();

  let thrown: unknown;
  await withMockedFetch(
    request => {
      const pre = copilotPreflight(request);
      if (pre) return pre;
      const url = new URL(request.url);
      if (url.pathname === '/models') return new Response('unavailable', { status: 503 });
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const instance = await createCopilotProvider(copilotUpstream);
      try { await instance.provider.getProvidedModels(); } catch (e) { thrown = e; }
    },
  );
  if (!(thrown instanceof ProviderModelsUnavailableError)) throw new Error('expected ProviderModelsUnavailableError');
  assertEquals(thrown.httpResponse?.status, 503);
});
