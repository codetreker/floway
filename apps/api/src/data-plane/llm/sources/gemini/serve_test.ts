import { test } from 'vitest';

import { clearCopilotTokenCache } from '../../../../shared/copilot.ts';
import { assertEquals, assertExists, assertFalse, assertStringIncludes } from '../../../../test-assert.ts';
import { buildCustomUpstreamRecord, copilotModels, jsonResponse, parseSSEText, requestApp, setupAppTest, sseChatCompletionsResponse, sseResponse, withMockedFetch } from '../../../../test-helpers.ts';
import { clearModelsStore } from '../../../providers/models-store.ts';

const mockTokenAndModels = (request: Request, models: Parameters<typeof copilotModels>[0]): Response | null => {
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
  if (url.pathname === '/models') return jsonResponse(copilotModels(models));

  return null;
};

const geminiRequest = (model = 'gpt-chat-native') => ({
  contents: [{ role: 'user', parts: [{ text: `hello ${model}` }] }],
});

test('/v1beta/models/:model:generateContent routes Gemini through native chat target', async () => {
  const { apiKey } = await setupAppTest();
  let upstreamPath = '';
  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const mocked = mockTokenAndModels(request, [
        {
          id: 'gpt-chat-native',
          supported_endpoints: ['/chat/completions'],
        },
      ]);
      if (mocked) return mocked;

      const url = new URL(request.url);
      upstreamPath = url.pathname;
      upstreamBody = JSON.parse(await request.text()) as Record<string, unknown>;

      if (url.pathname === '/chat/completions') {
        return sseChatCompletionsResponse({
          id: 'chatcmpl_gemini',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-chat-native',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'chat ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1beta/models/gpt-chat-native:generateContent', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify(geminiRequest()),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.candidates[0].content.parts, [{ text: 'chat ok' }]);
      assertEquals(body.candidates[0].finishReason, 'STOP');
      assertEquals(body.usageMetadata.totalTokenCount, 5);
    },
  );

  assertEquals(upstreamPath, '/chat/completions');
  assertExists(upstreamBody);
  assertEquals(upstreamBody.model, 'gpt-chat-native');
});

test('/v1beta/models/models/:model:generateContent accepts Gemini resource model names', async () => {
  const { apiKey } = await setupAppTest();
  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const mocked = mockTokenAndModels(request, [
        {
          id: 'gpt-chat-resource',
          supported_endpoints: ['/chat/completions'],
        },
      ]);
      if (mocked) return mocked;

      const url = new URL(request.url);
      upstreamBody = JSON.parse(await request.text()) as Record<string, unknown>;

      if (url.pathname === '/chat/completions') {
        return sseChatCompletionsResponse({
          id: 'chatcmpl_gemini_resource',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-chat-resource',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'resource ok' },
              finish_reason: 'stop',
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1beta/models/models/gpt-chat-resource:generateContent', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify(geminiRequest('gpt-chat-resource')),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.candidates[0].content.parts, [{ text: 'resource ok' }]);
    },
  );

  assertExists(upstreamBody);
  assertEquals(upstreamBody.model, 'gpt-chat-resource');
});

test('/v1beta/models/:model:generateContent uses Messages for Copilot Claude because the provider hides Chat', async () => {
  const { apiKey } = await setupAppTest();
  let upstreamPath = '';

  await withMockedFetch(
    request => {
      const mocked = mockTokenAndModels(request, [
        {
          id: 'claude-gemini-native',
          supported_endpoints: ['/v1/messages', '/chat/completions'],
        },
      ]);
      if (mocked) return mocked;

      const url = new URL(request.url);
      upstreamPath = url.pathname;

      if (url.pathname === '/v1/messages') {
        return sseResponse([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                content: [],
                model: 'claude-gemini-native',
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 4, output_tokens: 0 },
              },
            },
          },
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'messages ok' },
            },
          },
          {
            event: 'content_block_stop',
            data: { type: 'content_block_stop', index: 0 },
          },
          {
            event: 'message_delta',
            data: {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 2 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1beta/models/claude-gemini-native:generateContent', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify(geminiRequest('claude-gemini-native')),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.candidates[0].content.parts, [{ text: 'messages ok' }]);
    },
  );

  assertEquals(upstreamPath, '/v1/messages');
});

test('/v1beta/models/:model:generateContent routes Gemini through responses when only responses is supported', async () => {
  const { apiKey } = await setupAppTest();
  let upstreamPath = '';

  await withMockedFetch(
    request => {
      const mocked = mockTokenAndModels(request, [
        {
          id: 'gpt-responses-only',
          supported_endpoints: ['/responses'],
        },
      ]);
      if (mocked) return mocked;

      const url = new URL(request.url);
      upstreamPath = url.pathname;

      if (url.pathname === '/responses') {
        return sseResponse([
          {
            event: 'response.output_text.delta',
            data: {
              type: 'response.output_text.delta',
              sequence_number: 1,
              item_id: 'msg_1',
              output_index: 0,
              content_index: 0,
              delta: 'responses ok',
            },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              sequence_number: 2,
              response: {
                id: 'resp_1',
                object: 'response',
                created_at: 1,
                model: 'gpt-responses-only',
                status: 'completed',
                output: [],
                usage: {
                  input_tokens: 6,
                  output_tokens: 2,
                  total_tokens: 8,
                },
              },
            },
          },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1beta/models/gpt-responses-only:generateContent', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify(geminiRequest('gpt-responses-only')),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.candidates[0].content.parts, [{ text: 'responses ok' }]);
      assertEquals(body.usageMetadata.totalTokenCount, 8);
    },
  );

  assertEquals(upstreamPath, '/responses');
});

test('/v1beta/models/:model:streamGenerateContent returns Gemini data-only SSE and suppresses thoughts when requested', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const mocked = mockTokenAndModels(request, [
        {
          id: 'gpt-gemini-stream',
          supported_endpoints: ['/chat/completions'],
        },
      ]);
      if (mocked) return mocked;

      const url = new URL(request.url);
      if (url.pathname === '/chat/completions') {
        return sseResponse([
          {
            data: {
              id: 'chatcmpl_stream',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-gemini-stream',
              choices: [
                {
                  index: 0,
                  delta: { reasoning_text: 'hidden thought' },
                  finish_reason: null,
                },
              ],
            },
          },
          {
            data: {
              id: 'chatcmpl_stream',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-gemini-stream',
              choices: [
                {
                  index: 0,
                  delta: { reasoning_opaque: 'sig_1' },
                  finish_reason: null,
                },
              ],
            },
          },
          {
            data: {
              id: 'chatcmpl_stream',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-gemini-stream',
              choices: [
                {
                  index: 0,
                  delta: { content: 'visible' },
                  finish_reason: null,
                },
              ],
            },
          },
          {
            data: {
              id: 'chatcmpl_stream',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-gemini-stream',
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: 'stop',
                },
              ],
            },
          },
          { data: '[DONE]' },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1beta/models/gpt-gemini-stream:streamGenerateContent', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify({
          ...geminiRequest('gpt-gemini-stream'),
          generationConfig: { thinkingConfig: { includeThoughts: false } },
        }),
      });

      assertEquals(response.status, 200);
      assertEquals(response.headers.get('content-type')?.includes('text/event-stream'), true);
      const events = parseSSEText(await response.text());
      assertEquals(
        events.map(event => event.event),
        ['message', 'message'],
      );
      assertFalse(events.some(event => event.data === '[DONE]'));

      const first = JSON.parse(events[0].data);
      assertEquals(first.candidates[0].content.parts, [
        {
          text: 'visible',
          thoughtSignature: 'sig_1',
        },
      ]);
      const final = JSON.parse(events[1].data);
      assertEquals(final.candidates[0].finishReason, 'STOP');
    },
  );
});

test('/v1beta/models/:model:streamGenerateContent suppresses thoughts by default', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const mocked = mockTokenAndModels(request, [
        {
          id: 'gpt-gemini-default-thoughts',
          supported_endpoints: ['/chat/completions'],
        },
      ]);
      if (mocked) return mocked;

      const url = new URL(request.url);
      if (url.pathname === '/chat/completions') {
        return sseResponse([
          {
            data: {
              id: 'chatcmpl_default_thoughts',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-gemini-default-thoughts',
              choices: [
                {
                  index: 0,
                  delta: { reasoning_text: 'default hidden thought' },
                  finish_reason: null,
                },
              ],
            },
          },
          {
            data: {
              id: 'chatcmpl_default_thoughts',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-gemini-default-thoughts',
              choices: [
                {
                  index: 0,
                  delta: { reasoning_opaque: 'sig_default' },
                  finish_reason: null,
                },
              ],
            },
          },
          {
            data: {
              id: 'chatcmpl_default_thoughts',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-gemini-default-thoughts',
              choices: [
                {
                  index: 0,
                  delta: { content: 'visible default' },
                  finish_reason: null,
                },
              ],
            },
          },
          {
            data: {
              id: 'chatcmpl_default_thoughts',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'gpt-gemini-default-thoughts',
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: 'stop',
                },
              ],
            },
          },
          { data: '[DONE]' },
        ]);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1beta/models/gpt-gemini-default-thoughts:streamGenerateContent', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify(geminiRequest('gpt-gemini-default-thoughts')),
      });

      assertEquals(response.status, 200);
      const events = parseSSEText(await response.text());
      assertFalse(events.some(event => event.data === '[DONE]'));

      const first = JSON.parse(events[0].data);
      assertEquals(first.candidates[0].content.parts, [
        {
          text: 'visible default',
          thoughtSignature: 'sig_default',
        },
      ]);
      const final = JSON.parse(events[1].data);
      assertEquals(final.candidates[0].finishReason, 'STOP');
    },
  );
});

test('/v1beta/models/:model:generateContent malformed JSON returns Google RPC Status with debug fields', async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp('/v1beta/models/gpt-chat-native:generateContent', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey.key,
    },
    body: '{',
  });

  assertEquals(response.status, 500);
  const body = await response.json();
  assertEquals(body.error.code, 500);
  assertEquals(body.error.status, 'INTERNAL');
  assertEquals(body.error.name, 'SyntaxError');
  assertEquals(body.error.source_api, 'gemini');
  assertExists(body.error.stack);
});

test('/v1beta/models/:modelAction returns Google RPC 404 for malformed actions', async () => {
  const { apiKey } = await setupAppTest();
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey.key,
  };

  const missingAction = await requestApp('/v1beta/models/gpt-chat-native:', {
    method: 'POST',
    headers,
    body: '{}',
  });
  assertEquals(missingAction.status, 404);
  assertEquals(await missingAction.json(), {
    error: {
      code: 404,
      message: 'Unknown Gemini model action: gpt-chat-native:',
      status: 'NOT_FOUND',
    },
  });

  const unknownAction = await requestApp('/v1beta/models/gpt-chat-native:unknownAction', { method: 'POST', headers, body: '{}' });
  assertEquals(unknownAction.status, 404);
  assertEquals(await unknownAction.json(), {
    error: {
      code: 404,
      message: 'Unknown Gemini model action: unknownAction',
      status: 'NOT_FOUND',
    },
  });
});

test('/v1beta/models/:model:generateContent accepts x-goog-api-key', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const mocked = mockTokenAndModels(request, [
        {
          id: 'gpt-google-key',
          supported_endpoints: ['/chat/completions'],
        },
      ]);
      if (mocked) return mocked;

      if (new URL(request.url).pathname === '/chat/completions') {
        return sseChatCompletionsResponse({
          id: 'chatcmpl_google_key',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-google-key',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'authorized' },
              finish_reason: 'stop',
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1beta/models/gpt-google-key:generateContent', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey.key,
        },
        body: JSON.stringify(geminiRequest('gpt-google-key')),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.candidates[0].content.parts, [{ text: 'authorized' }]);
    },
  );
});

test('/v1beta/models/:model:generateContent accepts admin playground access', async () => {
  const { adminKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const mocked = mockTokenAndModels(request, [
        {
          id: 'gpt-admin-playground',
          supported_endpoints: ['/chat/completions'],
        },
      ]);
      if (mocked) return mocked;

      if (new URL(request.url).pathname === '/chat/completions') {
        return sseChatCompletionsResponse({
          id: 'chatcmpl_admin',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-admin-playground',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'playground' },
              finish_reason: 'stop',
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1beta/models/gpt-admin-playground:generateContent', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': adminKey,
          'x-models-playground': '1',
        },
        body: JSON.stringify(geminiRequest('gpt-admin-playground')),
      });

      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.candidates[0].content.parts, [{ text: 'playground' }]);
    },
  );
});

test('/v1beta/models/:model:generateContent preserves custom upstream /models HTTP errors', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearModelsStore();
  await clearCopilotTokenCache();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_custom',
    name: 'Custom Provider',
    enabled: true,
    sortOrder: 100,
    createdAt: '2026-05-01T00:00:00.000Z',
    flagOverrides: {},
    config: {
      baseUrl: 'https://custom.example.com',
      bearerToken: 'sk-custom',
      supportedEndpoints: ['/chat/completions'],
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ error: { message: 'bad custom key' } }, 401);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1beta/models/custom-gemini-model:generateContent', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey.key,
        },
        body: JSON.stringify(geminiRequest('custom-gemini-model')),
      });

      assertEquals(response.status, 401);
      const body = await response.json();
      assertEquals(body.error.code, 401);
      assertEquals(body.error.status, 'UNAUTHENTICATED');
      assertStringIncludes(body.error.message, 'bad custom key');
    },
  );
});
