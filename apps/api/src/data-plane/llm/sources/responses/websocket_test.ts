import type { ExecutionContext } from 'hono';
import { test } from 'vitest';

import { hashResponsesItemContent } from './items/format.ts';
import { app } from '../../../../app.ts';
import { assert, assertEquals, assertExists, assertStringIncludes } from '../../../../test-assert.ts';
import { copilotModels, jsonResponse, setupAppTest, sseResponsesResponse, withMockedFetch } from '../../../../test-helpers.ts';

type WorkerResponseInit = ResponseInit & { readonly webSocket?: WebSocket };

class TestWorkerWebSocket extends EventTarget {
  peer?: TestWorkerWebSocket;
  readyState: number = WebSocket.OPEN;

  accept(): void {}

  send(data: string): void {
    this.peer?.dispatchEvent(new MessageEvent('message', { data }));
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    if (this.peer) {
      this.peer.readyState = WebSocket.CLOSED;
      this.peer.dispatchEvent(new Event('close'));
    }
  }
}

const installWorkerWebSocketRuntime = (): {
  readonly pairs: Array<{ readonly client: TestWorkerWebSocket; readonly server: TestWorkerWebSocket }>;
  restore(): void;
} => {
  const globals = globalThis as typeof globalThis & {
    WebSocketPair?: unknown;
    Response: typeof Response;
  };
  const originalWebSocketPair = globals.WebSocketPair;
  const OriginalResponse = globals.Response;
  const pairs: Array<{ readonly client: TestWorkerWebSocket; readonly server: TestWorkerWebSocket }> = [];

  globals.WebSocketPair = class {
    constructor() {
      const client = new TestWorkerWebSocket();
      const server = new TestWorkerWebSocket();
      client.peer = server;
      server.peer = client;
      pairs.push({ client, server });
      return { 0: client, 1: server };
    }
  };

  globals.Response = class extends OriginalResponse {
    constructor(body?: BodyInit | null, init?: WorkerResponseInit) {
      if (init?.status === 101) {
        const { webSocket, status: _status, ...rest } = init;
        super(null, { ...rest, status: 200 });
        Object.defineProperty(this, 'status', { value: 101 });
        Object.defineProperty(this, 'webSocket', { value: webSocket });
        return;
      }
      super(body, init);
    }
  };

  return {
    pairs,
    restore: () => {
      globals.WebSocketPair = originalWebSocketPair;
      globals.Response = OriginalResponse;
    },
  };
};

const waitForMessages = async (
  socket: TestWorkerWebSocket,
  done: (messages: readonly Record<string, unknown>[]) => boolean,
): Promise<readonly Record<string, unknown>[]> => {
  const messages: Record<string, unknown>[] = [];
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      reject(new Error(`Timed out waiting for WebSocket messages; received ${JSON.stringify(messages)}`));
    }, 1_000);
    const onMessage = (event: Event): void => {
      const data = (event as MessageEvent<string>).data;
      messages.push(JSON.parse(data) as Record<string, unknown>);
      if (!done(messages)) return;
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      resolve(messages);
    };
    socket.addEventListener('message', onMessage);
  });
};

const connectResponsesWebSocket = async (apiKey: string): Promise<TestWorkerWebSocket> => {
  const executionCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  } satisfies ExecutionContext;
  const response = await app.fetch(new Request('https://example.test/v1/responses', {
    method: 'GET',
    headers: {
      upgrade: 'websocket',
      'x-api-key': apiKey,
    },
  }), {}, executionCtx);
  assertEquals(response.status, 101);

  const runtime = activeRuntime();
  const pair = runtime.pairs[0];
  assertExists(pair);
  return pair.client;
};

let currentRuntime: ReturnType<typeof installWorkerWebSocketRuntime> | undefined;

const activeRuntime = (): ReturnType<typeof installWorkerWebSocketRuntime> => {
  assertExists(currentRuntime);
  return currentRuntime;
};

const withWorkerWebSocketRuntime = async <T>(run: () => Promise<T>): Promise<T> => {
  const runtime = installWorkerWebSocketRuntime();
  currentRuntime = runtime;
  try {
    return await run();
  } finally {
    runtime.restore();
    currentRuntime = undefined;
  }
};

test('Responses WebSocket forwards stream events, echoes event_id, and sends response.done', async () => {
  const { apiKey } = await setupAppTest();
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600 });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        return sseResponsesResponse({
          id: 'resp_ws',
          object: 'response',
          model: 'gpt-direct-responses',
          status: 'completed',
          output: [],
          output_text: 'done',
          usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectResponsesWebSocket(apiKey.key);
      const received = waitForMessages(client, messages => messages.some(message => message.type === 'response.done'));

      client.send(JSON.stringify({
        type: 'response.create',
        event_id: 'evt_1',
        response: {
          model: 'gpt-direct-responses',
          input: 'hello',
        },
      }));

      const messages = await received;
      assert(messages.every(message => message.event_id === 'evt_1'));
      assert(messages.some(message => message.type === 'response.completed'));
      assertEquals(messages.at(-1), {
        type: 'response.done',
        event_id: 'evt_1',
        response: {
          id: 'resp_ws',
          usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
        },
      });
    }),
  );
});

test('Responses WebSocket returns OpenAI-style error envelopes for unsupported client events', async () => {
  const { apiKey } = await setupAppTest();
  await withWorkerWebSocketRuntime(async () => {
    const client = await connectResponsesWebSocket(apiKey.key);
    const received = waitForMessages(client, messages => messages.length === 1);

    client.send(JSON.stringify({ type: 'session.update', event_id: 'evt_bad' }));

    assertEquals(await received, [{
      type: 'error',
      event_id: 'evt_bad',
      status_code: 400,
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request_error',
        message: "Unsupported WebSocket event type 'session.update'.",
      },
    }]);
  });
});

test('Responses WebSocket returns invalid_request_error for malformed client messages', async () => {
  const { apiKey } = await setupAppTest();
  await withWorkerWebSocketRuntime(async () => {
    const client = await connectResponsesWebSocket(apiKey.key);
    const invalidJson = waitForMessages(client, messages => messages.length === 1);

    client.send('{bad json');

    const [invalidJsonMessage] = await invalidJson;
    assertExists(invalidJsonMessage);
    assertEquals(invalidJsonMessage.type, 'error');
    assertEquals(invalidJsonMessage.status_code, 400);
    assertEquals((invalidJsonMessage.error as { type?: unknown; code?: unknown }).type, 'invalid_request_error');
    assertEquals((invalidJsonMessage.error as { type?: unknown; code?: unknown }).code, 'invalid_request_error');
    assertStringIncludes((invalidJsonMessage.error as { message: string }).message, 'valid JSON');

    const invalidShape = waitForMessages(client, messages => messages.length === 1);
    client.send(JSON.stringify({ event_id: 'evt_shape', response: {} }));

    assertEquals(await invalidShape, [{
      type: 'error',
      event_id: 'evt_shape',
      status_code: 400,
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request_error',
        message: 'WebSocket message must be a JSON object with a string type.',
      },
    }]);

    const invalidResponse = waitForMessages(client, messages => messages.length === 1);
    client.send(JSON.stringify({ type: 'response.create', event_id: 'evt_response', response: {} }));

    assertEquals(await invalidResponse, [{
      type: 'error',
      event_id: 'evt_response',
      status_code: 400,
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request_error',
        message: 'response.create requires response.model to be a non-empty string.',
      },
    }]);
  });
});

test('Responses WebSocket forwards HTTP failures with status_code, error.code, and event_id', async () => {
  const { apiKey } = await setupAppTest();
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600 });
      }
      if (url.pathname === '/models') return jsonResponse(copilotModels([]));
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectResponsesWebSocket(apiKey.key);
      const received = waitForMessages(client, messages => messages.length === 1);

      client.send(JSON.stringify({
        type: 'response.create',
        event_id: 'evt_missing',
        response: {
          model: 'missing-model',
          input: 'hello',
        },
      }));

      assertEquals(await received, [{
        type: 'error',
        event_id: 'evt_missing',
        status_code: 404,
        error: {
          type: 'invalid_request_error',
          code: 'invalid_request_error',
          message: 'Model missing-model is not available on any configured upstream.',
        },
      }]);
    }),
  );
});

test('Responses WebSocket store:false keeps previous_response_id state in the session only', async () => {
  const { apiKey, repo } = await setupAppTest();
  const upstreamBodies: unknown[] = [];

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600 });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        upstreamBodies.push(JSON.parse(await request.text()));
        const turn = upstreamBodies.length;
        const label = turn === 1 ? 'first' : turn === 2 ? 'second' : 'third';
        return sseResponsesResponse({
          id: `resp_ws_${label}`,
          object: 'response',
          model: 'gpt-direct-responses',
          status: 'completed',
          output_text: `${label} answer`,
          output: [{
            id: `assistant_ws_${turn}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: `${label} answer` }],
          }],
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectResponsesWebSocket(apiKey.key);
      const firstDone = waitForMessages(client, messages => messages.some(message => message.type === 'response.done'));
      client.send(JSON.stringify({
        type: 'response.create',
        response: {
          model: 'gpt-direct-responses',
          input: 'first question',
          store: false,
        },
      }));
      const firstMessages = await firstDone;

      assertEquals(await repo.responsesSnapshots.lookup(apiKey.id, 'resp_ws_first'), null);
      const firstOutput = firstMessages.find(message => message.type === 'response.output_item.done') as { item?: { id?: string } } | undefined;
      assertExists(firstOutput?.item?.id);
      assertEquals(await repo.responsesItems.lookupMany(apiKey.id, [firstOutput.item.id]), []);
      assertEquals(
        await repo.responsesItems.lookupManyByContentHash(apiKey.id, [await hashResponsesItemContent({ type: 'message', role: 'user', content: 'first question' })]),
        [],
      );

      const secondDone = waitForMessages(client, messages => messages.filter(message => message.type === 'response.done').length === 1);
      client.send(JSON.stringify({
        type: 'response.create',
        response: {
          model: 'gpt-direct-responses',
          previous_response_id: 'resp_ws_first',
          input: 'second question',
          store: false,
        },
      }));
      await secondDone;

      const thirdDone = waitForMessages(client, messages => messages.filter(message => message.type === 'response.done').length === 1);
      client.send(JSON.stringify({
        type: 'response.create',
        response: {
          model: 'gpt-direct-responses',
          previous_response_id: 'resp_ws_second',
          input: 'third question',
        },
      }));
      await thirdDone;
    }),
  );

  assertEquals(await repo.responsesSnapshots.lookup(apiKey.id, 'resp_ws_second'), null);
  assertEquals(await repo.responsesSnapshots.lookup(apiKey.id, 'resp_ws_third'), null);
  const secondBody = upstreamBodies[1] as { previous_response_id?: unknown; input: Array<{ type: string; role?: string; content?: unknown }> };
  assertEquals(secondBody.previous_response_id, undefined);
  assertEquals(secondBody.input.map(item => [item.type, item.role, item.content]), [
    ['message', 'user', 'first question'],
    ['message', 'assistant', [{ type: 'output_text', text: 'first answer' }]],
    ['message', 'user', 'second question'],
  ]);
  const thirdBody = upstreamBodies[2] as { previous_response_id?: unknown; input: Array<{ type: string; role?: string; content?: unknown }> };
  assertEquals(thirdBody.previous_response_id, undefined);
  assertEquals(thirdBody.input.map(item => [item.type, item.role, item.content]), [
    ['message', 'user', 'first question'],
    ['message', 'assistant', [{ type: 'output_text', text: 'first answer' }]],
    ['message', 'user', 'second question'],
    ['message', 'assistant', [{ type: 'output_text', text: 'second answer' }]],
    ['message', 'user', 'third question'],
  ]);
});

test('Responses WebSocket store:true durable snapshots can chain through local session cache', async () => {
  const { apiKey, repo } = await setupAppTest();
  let turn = 0;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600 });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        turn += 1;
        return sseResponsesResponse({
          id: `resp_ws_durable_${turn}`,
          object: 'response',
          model: 'gpt-direct-responses',
          status: 'completed',
          output_text: `answer ${turn}`,
          output: [{
            id: `assistant_ws_durable_${turn}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: `answer ${turn}` }],
          }],
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectResponsesWebSocket(apiKey.key);
      const firstDone = waitForMessages(client, messages => messages.some(message => message.type === 'response.done'));
      client.send(JSON.stringify({ type: 'response.create', response: { model: 'gpt-direct-responses', input: 'first' } }));
      await firstDone;

      const secondDone = waitForMessages(client, messages => messages.some(message => message.type === 'response.done'));
      client.send(JSON.stringify({ type: 'response.create', response: { model: 'gpt-direct-responses', previous_response_id: 'resp_ws_durable_1', input: 'second' } }));
      await secondDone;
    }),
  );

  const firstSnapshot = await repo.responsesSnapshots.lookup(apiKey.id, 'resp_ws_durable_1');
  const secondSnapshot = await repo.responsesSnapshots.lookup(apiKey.id, 'resp_ws_durable_2');
  assertExists(firstSnapshot);
  assertExists(secondSnapshot);
  assertEquals(secondSnapshot.itemIds.length > firstSnapshot.itemIds.length, true);
});

test('Responses WebSocket aborts the in-flight Responses request when the client closes', async () => {
  const { apiKey } = await setupAppTest();
  let resolveResponsesStarted: (() => void) | undefined;
  const responsesStarted = new Promise<void>(resolve => {
    resolveResponsesStarted = resolve;
  });
  let resolveUpstreamAborted: (() => void) | undefined;
  const upstreamAborted = new Promise<void>(resolve => {
    resolveUpstreamAborted = resolve;
  });

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600 });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-direct-responses', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        resolveResponsesStarted?.();
        return await new Promise<Response>(resolve => {
          request.signal.addEventListener('abort', () => {
            resolveUpstreamAborted?.();
            resolve(sseResponsesResponse({
              id: 'resp_ws_abort',
              object: 'response',
              model: 'gpt-direct-responses',
              status: 'completed',
              output: [],
              output_text: '',
            }));
          }, { once: true });
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => await withWorkerWebSocketRuntime(async () => {
      const client = await connectResponsesWebSocket(apiKey.key);
      client.send(JSON.stringify({
        type: 'response.create',
        response: {
          model: 'gpt-direct-responses',
          input: 'hello',
        },
      }));

      await responsesStarted;
      client.close();
      await upstreamAborted;
    }),
  );
});
