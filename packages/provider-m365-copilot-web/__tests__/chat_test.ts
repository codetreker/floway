import { describe, expect, it, vi } from 'vitest';

import { openM365ChatTurn, type M365ChatTurnInput } from '../src/chat.ts';
import { SIGNALR_RECORD_SEPARATOR } from '../src/signalr.ts';
import type { WebSocketConnection, WebSocketConnectOptions, WebSocketMessage } from '@floway-dev/http';

const mockChat = () => {
  const sent: string[] = [];
  let controller!: ReadableStreamDefaultController<WebSocketMessage>;
  let resolveClosed!: (value: { code: number; reason: string; wasClean: boolean }) => void;
  let closed = false;
  const readable = new ReadableStream<WebSocketMessage>({
    start(value) {
      controller = value;
      value.enqueue({ type: 'text', data: `{${SIGNALR_RECORD_SEPARATOR}`.replace('{', '{}') });
    },
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    controller.close();
    resolveClosed({ code: 1000, reason: '', wasClean: true });
  };
  const connection: WebSocketConnection = {
    readable,
    writable: new WritableStream<WebSocketMessage>({
      write(message) {
        if (message.type !== 'text') throw new Error('unexpected binary write');
        sent.push(message.data);
      },
    }),
    protocol: '',
    closed: new Promise(resolve => { resolveClosed = resolve; }),
    close,
  };
  const connectWebSocket = vi.fn(async (_url: string, _options?: WebSocketConnectOptions) => connection);
  return {
    sent,
    controller,
    connectWebSocket,
    sendTurn(text = 'Hello') {
      controller.enqueue({
        type: 'text',
        data: JSON.stringify({ type: 1, target: 'update', arguments: [{ writeAtCursor: text }] }) + SIGNALR_RECORD_SEPARATOR
          + JSON.stringify({ type: 2, item: { turnState: 'Completed', messages: [{ author: 'bot', messageId: 'm1' }] } }) + SIGNALR_RECORD_SEPARATOR,
      });
    },
  };
};

const inputFor = (connectWebSocket: M365ChatTurnInput['connectWebSocket'], signal?: AbortSignal): M365ChatTurnInput => ({
  connectWebSocket,
  accessToken: 'opaque.secret.token',
  configuredChatHubHost: 'substrate.office.com',
  configuredChatHubPath: 'opaque@path',
  modelId: 'm365-copilot-auto',
  tone: 'magic',
  prompt: 'hello',
  session: { sessionId: 'session', conversationId: 'conversation', turnCount: 0 },
  locale: 'en-GB',
  timeZone: 'Europe/London',
  timeZoneOffsetMinutes: 60,
  signal,
  wrapUpstreamCall: dispatch => dispatch(),
});

describe('M365 ChatHub turn', () => {
  it('awaits the handshake, sends chat and Metrics together, and emits typed terminal frames', async () => {
    const mock = mockChat();
    const opened = await openM365ChatTurn(inputFor(mock.connectWebSocket));
    expect(mock.sent).toEqual([JSON.stringify({ protocol: 'json', version: 1 }) + SIGNALR_RECORD_SEPARATOR]);
    const stream = await opened.dispatch();
    expect(mock.sent[1]!.split(SIGNALR_RECORD_SEPARATOR).filter(Boolean).map(value => JSON.parse(value)).map(frame => frame.target)).toEqual(['chat', 'Metrics']);
    mock.sendTurn();
    const frames = [];
    for await (const frame of stream.events) frames.push(frame);
    expect(frames.at(-1)).toEqual({ type: 'done' });
    expect(frames.filter(frame => frame.type === 'event').map(frame => frame.event.choices[0]?.finish_reason)).toContain('stop');
    expect(await stream.diagnostics).toMatchObject({ messageId: 'm1', turnState: 'Completed' });
    const [url, options] = mock.connectWebSocket.mock.calls[0]!;
    expect(url).toContain('/opaque%40path?');
    expect(new URL(url).searchParams.get('access_token')).toBe('opaque.secret.token');
    expect(options?.headers).toContainEqual(['origin', 'https://m365.cloud.microsoft']);
  });

  it('sends the captured Stop frame when a dispatched turn is aborted', async () => {
    const abort = new AbortController();
    const mock = mockChat();
    const stream = await (await openM365ChatTurn(inputFor(mock.connectWebSocket, abort.signal))).dispatch();
    const consume = (async () => {
      for await (const _frame of stream.events) { /* consume */ }
    })();
    abort.abort(new Error('cancelled'));
    await vi.waitFor(() => expect(mock.sent.some(record => record.includes('"target":"stop"'))).toBe(true));
    mock.sendTurn('partial');
    await expect(consume).rejects.toThrow('cancelled');
    expect(mock.sent.filter(record => record.includes('"target":"stop"'))).toHaveLength(1);
  });

  it('aborts while waiting for the SignalR handshake', async () => {
    const abort = new AbortController();
    let closed = false;
    const connection: WebSocketConnection = {
      readable: new ReadableStream<WebSocketMessage>(),
      writable: new WritableStream<WebSocketMessage>(),
      protocol: '',
      closed: new Promise(() => {}),
      close: async () => { closed = true; },
    };
    const opening = openM365ChatTurn(inputFor(async () => connection, abort.signal));
    abort.abort(new Error('handshake cancelled'));
    await expect(opening).rejects.toThrow('handshake cancelled');
    expect(closed).toBe(true);
  });

  it('cancels an active pending read immediately after Stop and close', async () => {
    const abort = new AbortController();
    const sent: string[] = [];
    let cancelled = 0;
    const readable = new ReadableStream<WebSocketMessage>({
      start(controller) {
        controller.enqueue({ type: 'text', data: `{${SIGNALR_RECORD_SEPARATOR}`.replace('{', '{}') });
      },
      cancel() { cancelled++; },
    });
    const connection: WebSocketConnection = {
      readable,
      writable: new WritableStream<WebSocketMessage>({
        write(message) { if (message.type === 'text') sent.push(message.data); },
      }),
      protocol: '',
      closed: new Promise(() => {}),
      close: async () => {},
    };
    const stream = await (await openM365ChatTurn(inputFor(async () => connection, abort.signal))).dispatch();
    const diagnosticsFailure = expect(stream.diagnostics).rejects.toThrow('active read cancelled');
    const iterator = stream.events[Symbol.asyncIterator]();
    await iterator.next();
    const pending = iterator.next();
    const failure = expect(pending).rejects.toThrow('active read cancelled');
    abort.abort(new Error('active read cancelled'));
    await failure;
    await diagnosticsFailure;
    expect(sent.filter(record => record.includes('"target":"stop"'))).toHaveLength(1);
    expect(cancelled).toBe(1);
  });

  it('aborts hung handshake and dispatch writes', async () => {
    const handshakeAbort = new AbortController();
    const handshakeConnection: WebSocketConnection = {
      readable: new ReadableStream<WebSocketMessage>(),
      writable: new WritableStream<WebSocketMessage>({ write: async () => await new Promise<void>(() => {}) }),
      protocol: '',
      closed: new Promise(() => {}),
      close: async () => {},
    };
    const opening = openM365ChatTurn(inputFor(async () => handshakeConnection, handshakeAbort.signal));
    const handshakeFailure = new Error('handshake write aborted');
    const openingOutcome = opening.catch(value => value);
    handshakeAbort.abort(handshakeFailure);
    const openingError = await openingOutcome;
    expect(openingError === handshakeFailure || openingError.cause === handshakeFailure).toBe(true);

    vi.useFakeTimers();
    try {
      const dispatchAbort = new AbortController();
      let writes = 0;
      const dispatchConnection: WebSocketConnection = {
        readable: new ReadableStream<WebSocketMessage>({
          start(controller) { controller.enqueue({ type: 'text', data: `{${SIGNALR_RECORD_SEPARATOR}`.replace('{', '{}') }); },
        }),
        writable: new WritableStream<WebSocketMessage>({
          write: async () => {
            writes++;
            if (writes === 2) await new Promise<void>(() => {});
          },
        }),
        protocol: '',
        closed: new Promise(() => {}),
        close: async () => {},
      };
      const opened = await openM365ChatTurn(inputFor(async () => dispatchConnection, dispatchAbort.signal));
      const dispatching = opened.dispatch();
      const dispatchFailure = new Error('dispatch write aborted');
      const dispatchRejected = expect(dispatching).rejects.toMatchObject({ cause: dispatchFailure });
      dispatchAbort.abort(dispatchFailure);
      await vi.advanceTimersByTimeAsync(5_000);
      await dispatchRejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves handshake cleanup failures with the primary protocol error', async () => {
    const cancelFailure = new Error('reader cleanup failed');
    const closeFailure = new Error('socket cleanup failed');
    const connection: WebSocketConnection = {
      readable: new ReadableStream<WebSocketMessage>({
        start(controller) { controller.enqueue({ type: 'binary', data: new Uint8Array([1]) }); },
        cancel() { throw cancelFailure; },
      }),
      writable: new WritableStream<WebSocketMessage>(),
      protocol: '',
      closed: new Promise(() => {}),
      close: async () => { throw closeFailure; },
    };
    const error = await openM365ChatTurn(inputFor(async () => connection)).catch(value => value);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.cause).toMatchObject({ code: 'upstream_protocol_error' });
    expect(error.errors).toEqual([error.cause, cancelFailure, closeFailure]);
  });
});
