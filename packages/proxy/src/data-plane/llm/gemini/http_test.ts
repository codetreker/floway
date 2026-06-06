import { Hono } from 'hono';
import { test, vi } from 'vitest';

import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ProviderCallResult, ProviderStreamResult } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubUpstreamModel } from '@floway-dev/test-utils';

const candidatesQueue: { readonly candidates: readonly ProviderCandidate[]; readonly sawModel: boolean }[] = [];
vi.mock('../shared/candidates.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../shared/candidates.ts')>();
  return {
    ...original,
    enumerateProviderCandidates: vi.fn(async () => {
      const next = candidatesQueue.shift();
      if (next === undefined) throw new Error('http_test: no candidates enqueued');
      return next;
    }),
  };
});

const { geminiHttp } = await import('./http.ts');

const API_KEY_ID = 'key_gemini_http_test';

const queueCandidates = (candidates: readonly ProviderCandidate[], sawModel = candidates.length > 0): void => {
  candidatesQueue.push({ candidates, sawModel });
};

const installRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return repo;
};

const makeApp = (): Hono<{ Variables: { apiKeyId: string; apiKeyUpstreamIds: readonly string[] } }> => {
  const app = new Hono<{ Variables: { apiKeyId: string; apiKeyUpstreamIds: readonly string[] } }>();
  app.use('*', async (c, next) => {
    c.set('apiKeyId', API_KEY_ID);
    await next();
  });
  app.post('/v1beta/models/:modelAction{.+}', geminiHttp);
  return app;
};

const makeChatCompletionsEvents = (): readonly ChatCompletionsStreamEvent[] => [
  {
    id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
];

const makeProtocolFrames = async function* <TEvent>(events: readonly TEvent[]): AsyncGenerator<ProtocolFrame<TEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (overrides: {
  upstream?: string;
  targetApi?: ProviderCandidate['targetApi'];
  callChatCompletions?: (model: unknown, body: unknown, signal?: AbortSignal, headers?: Record<string, string>) => Promise<ProviderStreamResult<ChatCompletionsStreamEvent>>;
  callMessages?: (model: unknown, body: unknown, signal?: AbortSignal, headers?: Record<string, string>, anthropicBeta?: readonly string[]) => Promise<ProviderStreamResult<MessagesStreamEvent>>;
  callMessagesCountTokens?: (model: unknown, body: unknown, signal?: AbortSignal, headers?: Record<string, string>, anthropicBeta?: readonly string[]) => Promise<ProviderCallResult>;
} = {}): ProviderCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const targetApi = overrides.targetApi ?? 'chat-completions';
  const upstreamModel = stubUpstreamModel();
  const provider = stubProvider({
    callChatCompletions: overrides.callChatCompletions,
    callMessages: overrides.callMessages,
    callMessagesCountTokens: overrides.callMessagesCountTokens,
  });
  return {
    provider: {
      upstream, providerKind: 'custom', name: upstream,
      disabledPublicModelIds: [], provider, supportsResponsesItemReference: true,
    },
    binding: {
      upstream, upstreamName: upstream, providerKind: 'custom', provider, upstreamModel,
      enabledFlags: upstreamModel.enabledFlags, supportsResponsesItemReference: true,
    },
    targetApi,
  };
};

const makeMessagesEvents = (): readonly MessagesStreamEvent[] => [
  {
    type: 'message_start',
    message: {
      id: 'msg_http_m', type: 'message', role: 'assistant', content: [],
      model: 'test-model', stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 0 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];

test('POST /v1beta/models/:model:generateContent returns a single JSON body for non-stream generate', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'k',
  }));
  queueCandidates([makeCandidate({ callChatCompletions })]);

  const response = await makeApp().request('/v1beta/models/test-model:generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as { candidates?: { content: { parts: { text: string }[] } }[] };
  assert(body.candidates && body.candidates.length > 0);
  assertEquals(callChatCompletions.mock.calls.length, 1);
});

test('POST /v1beta/models/:model:streamGenerateContent streams a Gemini SSE body', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'k',
  }));
  queueCandidates([makeCandidate({ callChatCompletions })]);

  const response = await makeApp().request('/v1beta/models/test-model:streamGenerateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'text/event-stream');
  const text = await response.text();
  assert(text.length > 0);
  assertEquals(callChatCompletions.mock.calls.length, 1);
});

test('POST /v1beta/models/:model:countTokens returns the Gemini totalTokens envelope', async () => {
  installRepo();
  const callMessagesCountTokens = vi.fn(async (): Promise<ProviderCallResult> => ({
    response: new Response(JSON.stringify({ input_tokens: 23 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
    modelKey: 'k',
  }));
  queueCandidates([makeCandidate({ targetApi: 'messages', callMessagesCountTokens })]);

  const response = await makeApp().request('/v1beta/models/test-model:countTokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { totalTokens: 23 });
  assertEquals(callMessagesCountTokens.mock.calls.length, 1);
});

test('POST /v1beta/models/:model:countTokens accepts the generateContentRequest envelope shape', async () => {
  installRepo();
  const callMessagesCountTokens = vi.fn(async (): Promise<ProviderCallResult> => ({
    response: new Response(JSON.stringify({ total_tokens: 7 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
    modelKey: 'k',
  }));
  queueCandidates([makeCandidate({ targetApi: 'messages', callMessagesCountTokens })]);

  const response = await makeApp().request('/v1beta/models/test-model:countTokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      generateContentRequest: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    }),
  });

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { totalTokens: 7 });
});

test('POST /v1beta/models/:model:generateContent translates through Messages target end to end', async () => {
  installRepo();
  const callMessages = vi.fn(async (): Promise<ProviderStreamResult<MessagesStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeMessagesEvents()), modelKey: 'k',
  }));
  queueCandidates([makeCandidate({ targetApi: 'messages', callMessages })]);

  const response = await makeApp().request('/v1beta/models/test-model:generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as { candidates?: { content: { parts: { text: string }[] } }[] };
  assert(body.candidates && body.candidates.length > 0);
  assertEquals(callMessages.mock.calls.length, 1);
});

test('POST /v1beta/models/:model:unknownAction returns a Google RPC 404 envelope', async () => {
  installRepo();
  // No candidates queued — the action parser short-circuits before routing.
  const response = await makeApp().request('/v1beta/models/test-model:unknownAction', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

  assertEquals(response.status, 404);
  const body = await response.json() as { error: { code: number; status: string; message: string } };
  assertEquals(body.error.code, 404);
  assertEquals(body.error.status, 'NOT_FOUND');
  assert(body.error.message.includes('Unknown Gemini model action'));
});

test('POST /v1beta/models/models/:model:generateContent accepts the models/ prefix in the path id', async () => {
  installRepo();
  let resolvedModel: string | undefined;
  const callChatCompletions = vi.fn(async (model): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => {
    resolvedModel = (model as { id: string }).id;
    return { ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'k' };
  });
  queueCandidates([makeCandidate({ callChatCompletions })]);

  const response = await makeApp().request('/v1beta/models/models/test-model:generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });

  assertEquals(response.status, 200);
  // The `models/` prefix is normalised away before reaching candidate enumeration.
  assertEquals(resolvedModel, stubUpstreamModel().id);
});
