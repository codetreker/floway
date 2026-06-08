import { Hono } from 'hono';
import { test, vi } from 'vitest';

import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
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

const { messagesHttp } = await import('./http.ts');

const API_KEY_ID = 'key_messages_http_test';

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
  app.post('/v1/messages', messagesHttp.generate);
  app.post('/v1/messages/count_tokens', messagesHttp.countTokens);
  return app;
};

const makeMessagesEvents = (): readonly MessagesStreamEvent[] => [
  {
    type: 'message_start',
    message: {
      id: 'msg_http',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'test-model',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 0 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];

const makeProtocolFrames = async function* <TEvent>(events: readonly TEvent[]): AsyncGenerator<ProtocolFrame<TEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (overrides: {
  upstream?: string;
  callMessages?: (model: unknown, body: unknown, signal?: AbortSignal, headers?: Record<string, string>, anthropicBeta?: readonly string[]) => Promise<ProviderStreamResult<MessagesStreamEvent>>;
  callMessagesCountTokens?: (model: unknown, body: unknown, signal?: AbortSignal, headers?: Record<string, string>, anthropicBeta?: readonly string[]) => Promise<ProviderCallResult>;
} = {}): ProviderCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const upstreamModel = stubUpstreamModel();
  const provider = stubProvider({
    callMessages: overrides.callMessages,
    callMessagesCountTokens: overrides.callMessagesCountTokens,
  });
  return {
    provider: {
      upstream,
      providerKind: 'custom',
      name: upstream,
      disabledPublicModelIds: [],
      provider,
      supportsResponsesItemReference: true,
    },
    binding: {
      upstream,
      upstreamName: upstream,
      providerKind: 'custom',
      provider,
      upstreamModel,
      enabledFlags: upstreamModel.enabledFlags,
      supportsResponsesItemReference: true,
    },
    targetApi: 'messages',
  };
};

test('POST /v1/messages streams a successful SSE body', async () => {
  installRepo();
  const callMessages = vi.fn(async (): Promise<ProviderStreamResult<MessagesStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeMessagesEvents()), modelKey: 'k',
  }));
  queueCandidates([makeCandidate({ callMessages })]);

  const response = await makeApp().request('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test-model', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hello' }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'text/event-stream');
  const body = await response.text();
  assert(body.includes('event: message_start'));
  assert(body.includes('event: message_stop'));
  assertEquals(callMessages.mock.calls.length, 1);
});

test('POST /v1/messages returns a single JSON body when stream is omitted', async () => {
  installRepo();
  const callMessages = vi.fn(async (): Promise<ProviderStreamResult<MessagesStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeMessagesEvents()), modelKey: 'k',
  }));
  queueCandidates([makeCandidate({ callMessages })]);

  const response = await makeApp().request('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test-model', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as { role: string; content: unknown };
  assertEquals(body.role, 'assistant');
});

test('POST /v1/messages rejects body anthropic_beta with a 400 before routing', async () => {
  installRepo();
  // No candidates queued — the http entry rejects before reaching the serve.
  const response = await makeApp().request('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test-model',
      max_tokens: 32,
      anthropic_beta: ['something'],
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });

  assertEquals(response.status, 400);
  const body = await response.json() as { error: { param: string; type: string } };
  assertEquals(body.error.param, 'anthropic_beta');
  assertEquals(body.error.type, 'invalid_request_error');
});

test('POST /v1/messages/count_tokens proxies the upstream measurement body', async () => {
  installRepo();
  const callMessagesCountTokens = vi.fn(async (): Promise<ProviderCallResult> => ({
    response: new Response(JSON.stringify({ input_tokens: 99 }), { status: 200, headers: { 'content-type': 'application/json' } }),
    modelKey: 'k',
  }));
  queueCandidates([makeCandidate({ callMessagesCountTokens })]);

  const response = await makeApp().request('/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test-model', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] }),
  });

  assertEquals(response.status, 200);
  const body = await response.json() as { input_tokens: number };
  assertEquals(body.input_tokens, 99);
  assertEquals(callMessagesCountTokens.mock.calls.length, 1);
});
