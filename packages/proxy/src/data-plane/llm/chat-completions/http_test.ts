import { type Context, Hono } from 'hono';
import { test, vi } from 'vitest';

import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ProviderStreamResult } from '@floway-dev/provider';
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

const { chatCompletionsHttp } = await import('./http.ts');

const API_KEY_ID = 'key_chat_completions_http_test';

const queueCandidates = (candidates: readonly ProviderCandidate[], sawModel = candidates.length > 0): void => {
  candidatesQueue.push({ candidates, sawModel });
};

const installRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return repo;
};

interface AuthVars {
  apiKeyId: string;
  apiKeyUpstreamIds: readonly string[];
}

const makeApp = (middleware?: (c: Context) => void): Hono<{ Variables: AuthVars }> => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use('*', async (c, next) => {
    c.set('apiKeyId', API_KEY_ID);
    middleware?.(c);
    await next();
  });
  app.post('/v1/chat/completions', chatCompletionsHttp.generate);
  return app;
};

const makeChatCompletionsEvents = (): readonly ChatCompletionsStreamEvent[] => [
  {
    id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 0, model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 0, model: 'test-model',
    choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 0, model: 'test-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
  {
    id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 0, model: 'test-model',
    choices: [],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  },
];

const makeProtocolFrames = async function* <TEvent>(events: readonly TEvent[]): AsyncGenerator<ProtocolFrame<TEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (overrides: {
  upstream?: string;
  callChatCompletions?: (model: unknown, body: unknown, signal?: AbortSignal, headers?: Record<string, string>) => Promise<ProviderStreamResult<ChatCompletionsStreamEvent>>;
} = {}): ProviderCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const upstreamModel = stubUpstreamModel();
  const provider = stubProvider({ callChatCompletions: overrides.callChatCompletions });
  return {
    provider: {
      upstream, providerKind: 'custom', name: upstream,
      disabledPublicModelIds: [], provider, supportsResponsesItemReference: true,
    },
    binding: {
      upstream, upstreamName: upstream, providerKind: 'custom',
      provider, upstreamModel, enabledFlags: upstreamModel.enabledFlags,
      supportsResponsesItemReference: true,
    },
    targetApi: 'chat-completions',
  };
};

test('POST /v1/chat/completions streams a successful SSE body', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'k',
  }));
  queueCandidates([makeCandidate({ callChatCompletions })]);

  const response = await makeApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hello' }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'text/event-stream');
  const body = await response.text();
  assert(body.includes('chatcmpl_http'));
  assert(body.includes('[DONE]'));
  assertEquals(callChatCompletions.mock.calls.length, 1);
});

test('POST /v1/chat/completions returns a single JSON body when stream is omitted', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'k',
  }));
  queueCandidates([makeCandidate({ callChatCompletions })]);

  const response = await makeApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as { choices: Array<{ message: { role: string; content: string } }> };
  assertEquals(body.choices[0].message.role, 'assistant');
  assertEquals(body.choices[0].message.content, 'hi');
});

test('POST /v1/chat/completions omits the usage-only chunk unless stream_options.include_usage is set', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'k',
  }));
  queueCandidates([makeCandidate({ callChatCompletions })]);

  const response = await makeApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hello' }] }),
  });

  assertEquals(response.status, 200);
  const body = await response.text();
  // The usage-only chunk has empty choices array; absence verifies the filter.
  assert(!body.includes('"choices":[]'));
});

test('POST /v1/chat/completions emits the usage-only chunk when stream_options.include_usage is true', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'k',
  }));
  queueCandidates([makeCandidate({ callChatCompletions })]);

  const response = await makeApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test-model',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });

  assertEquals(response.status, 200);
  const body = await response.text();
  assert(body.includes('"choices":[]'));
  assert(body.includes('"prompt_tokens":4'));
});

// The http entry MUST NOT mutate any non-auth Hono context slot — caller
// intent (stream_options.include_usage, etc.) belongs in the request-scoped
// locals the entry threads through serve, never in middleware-visible
// context-slot smuggling.
test('POST /v1/chat/completions does not write any non-auth Hono context slot', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'k',
  }));
  queueCandidates([makeCandidate({ callChatCompletions })]);

  const knownAuthKeys = new Set(['apiKeyId', 'apiKeyUpstreamIds']);
  const observedKeys: string[] = [];

  const app = makeApp(c => {
    const originalSet = c.set.bind(c);
    c.set = ((key: string, value: unknown) => {
      observedKeys.push(key);
      return originalSet(key, value);
    }) as typeof c.set;
  });

  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test-model',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });

  assertEquals(response.status, 200);
  await response.text();

  const unexpectedKeys = observedKeys.filter(key => !knownAuthKeys.has(key));
  assertEquals(unexpectedKeys, []);
});
