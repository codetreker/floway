import { type Context, Hono } from 'hono';
import { test } from 'vitest';

import { respondChatCompletions } from './chat-completions/respond.ts';
import type { SourceExecutionContext } from './execute.ts';
import { respondGemini } from './gemini/respond.ts';
import { respondMessages } from './messages/respond.ts';
import { respondResponses } from './responses/respond.ts';
import { assertEquals } from '../../../test-assert.ts';
import { FakeTime } from '../../../test-time.ts';
import type { ChatCompletionChunk } from '../../shared/protocol/chat-completions.ts';
import type { GeminiStreamEvent } from '../../shared/protocol/gemini.ts';
import type { MessagesStreamEventData } from '../../shared/protocol/messages.ts';
import { eventResult } from '../shared/errors/result.ts';
import type { ResponsesStreamEvent } from '../shared/protocol/responses.ts';
import { DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS } from '../shared/stream/proxy-sse.ts';
import type { ProtocolFrame } from '../shared/stream/types.ts';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });

  return { promise, resolve };
};

const closedIteratorResult = <TEvent>(): IteratorResult<ProtocolFrame<TEvent>> => ({
  done: true,
  value: undefined,
});

const createIdleProtocolEvents = <TEvent>() => {
  let pendingNext: Deferred<IteratorResult<ProtocolFrame<TEvent>>> | undefined;
  let returnCalled = false;

  const events: AsyncIterable<ProtocolFrame<TEvent>> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          pendingNext = deferred<IteratorResult<ProtocolFrame<TEvent>>>();
          return pendingNext.promise;
        },
        return() {
          returnCalled = true;
          pendingNext?.resolve(closedIteratorResult<TEvent>());
          return Promise.resolve(closedIteratorResult<TEvent>());
        },
      };
    },
  };

  return {
    events,
    hasPendingNext: () => pendingNext !== undefined,
    returnCalled: () => returnCalled,
  };
};

const waitForIteratorStart = async (events: ReturnType<typeof createIdleProtocolEvents>) => {
  for (let i = 0; i < 10; i++) {
    if (events.hasPendingNext()) return;
    await Promise.resolve();
  }

  throw new Error('protocol iterator did not start');
};

const requestResponse = async <TEvent>(events: AsyncIterable<ProtocolFrame<TEvent>>, respond: (c: Context, events: AsyncIterable<ProtocolFrame<TEvent>>) => Promise<Response>): Promise<Response> => {
  const app = new Hono();
  app.get('/', c => respond(c, events));
  return await app.request('/');
};

const decodeChunk = (value: Uint8Array | undefined): string => new TextDecoder().decode(value);

const readKeepAliveChunk = async (response: Response, time: FakeTime): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; text: string }> => {
  const reader = response.body!.getReader();
  const read = reader.read().then(chunk => (chunk.done ? '<closed>' : decodeChunk(chunk.value)));

  await time.tickAsync(DOWNSTREAM_KEEP_ALIVE_INTERVAL_MS);
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    const text = await Promise.race([read, Promise.resolve(null)]);
    if (text !== null) return { reader, text };
  }

  return { reader, text: '<pending>' };
};

const assertSourceKeepAlive = async <TEvent>(respond: (c: Context, events: AsyncIterable<ProtocolFrame<TEvent>>) => Promise<Response>, expected: string) => {
  const time = new FakeTime();
  const idle = createIdleProtocolEvents<TEvent>();

  try {
    const response = await requestResponse(idle.events, respond);
    await waitForIteratorStart(idle);
    const { reader, text } = await readKeepAliveChunk(response, time);

    try {
      assertEquals(text, expected);
    } finally {
      await reader.cancel();
    }
  } finally {
    time.restore();
  }
};

const testTelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key',
};

const recordUsage = () => Promise.resolve();
const recordRequestPerformance = () => {};
const requestStartedAt = performance.now();
const source = (): SourceExecutionContext => ({
  requestStartedAt,
  runtimeLocation: 'test',
  recordUsage,
  recordRequestPerformance,
  beginDownstream: () => undefined,
  rememberPerformance: result => result,
});

test('Messages streaming keepalive uses Anthropic ping events', async () => {
  await assertSourceKeepAlive<MessagesStreamEventData>((c, events) => respondMessages(c, eventResult(events, testTelemetryModelIdentity), true, source()), 'event: ping\ndata: {"type":"ping"}\n\n');
});

test('Responses streaming keepalive uses SSE comments', async () => {
  await assertSourceKeepAlive<ResponsesStreamEvent>((c, events) => respondResponses(c, eventResult(events, testTelemetryModelIdentity), true, source()), ': keepalive\n\n');
});

test('Chat Completions streaming keepalive uses SSE comments', async () => {
  await assertSourceKeepAlive<ChatCompletionChunk>((c, events) => respondChatCompletions(c, eventResult(events, testTelemetryModelIdentity), true, true, source()), ': keepalive\n\n');
});

test('Gemini streaming keepalive uses SSE comments', async () => {
  await assertSourceKeepAlive<GeminiStreamEvent>((c, events) => respondGemini(c, eventResult(events, testTelemetryModelIdentity), true, source()), ': keepalive\n\n');
});
