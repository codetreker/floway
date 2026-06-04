import type { Context } from 'hono';

import { RESPONSES_MISSING_TERMINAL_MESSAGE } from './events/to-result.ts';
import { createWebSocketStatefulResponsesSession } from './stateful-store.ts';
import { responsesTraits, setupResponsesSource } from './traits.ts';
import { tokenUsage } from '../../../shared/telemetry/usage.ts';
import type { RequestContext } from '../../interceptors.ts';
import type { StreamCompletion } from '../../shared/stream/proxy-sse.ts';
import { executeLlmSourcePlan } from '../execution.ts';
import { eventResultMetadata, recordSourcePerformance, recordSourceUsage, SourceStreamState } from '../respond.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { isResponsesTerminalEvent, type ResponsesStreamEvent, type ResponsesPayload, type ResponsesResult } from '@floway-dev/protocols/responses';
import type { ExecuteResult, PlainResult } from '@floway-dev/provider';
import { toInternalDebugError } from '@floway-dev/provider';

interface WorkerWebSocket extends WebSocket {
  accept(): void;
}

declare const WebSocketPair: {
  new(): {
    0: WorkerWebSocket;
    1: WorkerWebSocket;
  };
};

interface ResponsesWebSocketClientEvent {
  type: string;
  event_id?: string;
  response?: Partial<ResponsesPayload>;
  [key: string]: unknown;
}

export const responsesWebSocket = async (c: Context): Promise<Response> => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return Response.json({ error: 'Expected Upgrade: websocket' }, { status: 426 });
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  const session = createWebSocketStatefulResponsesSession();
  let closed = false;
  let activeAbortController: AbortController | undefined;
  let queue = Promise.resolve();

  const closeActiveRequest = (): void => {
    closed = true;
    activeAbortController?.abort();
  };
  server.addEventListener('close', closeActiveRequest);
  server.addEventListener('error', closeActiveRequest);
  server.addEventListener('message', event => {
    queue = queue
      .then(async () => {
        if (closed) return;
        const abortController = new AbortController();
        activeAbortController = abortController;
        try {
          await handleClientMessage(c, server, session, event.data, abortController, () => closed);
        } finally {
          if (activeAbortController === abortController) activeAbortController = undefined;
        }
      })
      .catch(error => {
        if (!closed) sendError(server, 500, serverErrorEnvelope(error));
      });
  });

  return new Response(null, { status: 101, webSocket: client } as ResponseInit & { readonly webSocket: WebSocket });
};

const handleClientMessage = async (
  c: Context,
  socket: WebSocket,
  session: ReturnType<typeof createWebSocketStatefulResponsesSession>,
  data: unknown,
  downstreamAbortController: AbortController,
  isClosed: () => boolean,
): Promise<void> => {
  const signal = downstreamAbortController.signal;
  let eventId: string | undefined;
  try {
    const parsed = parseClientMessageData(data);
    eventId = parsed && typeof parsed === 'object' && typeof (parsed as { event_id?: unknown }).event_id === 'string'
      ? (parsed as { event_id: string }).event_id
      : undefined;
    const message = validateClientMessage(parsed);
    if (message.type !== 'response.create') {
      sendError(socket, 400, {
        type: 'invalid_request_error',
        code: 'invalid_request_error',
        message: `Unsupported WebSocket event type '${message.type}'.`,
      }, eventId);
      return;
    }

    const source = message.response && typeof message.response === 'object'
      ? message.response
      : Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'type' && key !== 'event_id'));
    const payload = responsesPayloadFromClientSource(source);
    const storage = session.createStore((c.get('apiKeyId') as string | undefined) ?? null, payload.store);
    const plan = await setupResponsesSource(c, payload, {
      downstreamAbortController,
      statefulResponsesStore: storage.statefulResponsesStore,
      storedItemsStore: storage.outputStore,
      snapshotMode: storage.snapshotMode,
    });
    if (plan instanceof Response) {
      if (signal.aborted || isClosed()) return;
      const contentType = plan.headers.get('content-type') ?? '';
      const body = contentType.includes('application/json') ? await plan.json() : { message: await plan.text() };
      if (signal.aborted || isClosed()) return;
      if (!plan.ok) {
        sendError(socket, plan.status, normalizeErrorBody(body, plan.status), eventId);
        return;
      }
      sendJson(socket, body, eventId);
      return;
    }

    const { result, commitForNonStreaming } = await executeLlmSourcePlan(plan, failure => responsesTraits.renderFailure(failure, 'generate'));
    const success = await respondResponsesWebSocket({
      socket,
      eventId,
      signal,
      isClosed,
      result,
      request: plan.request,
    });
    if (success) await commitForNonStreaming?.();
  } catch (error) {
    if (signal.aborted || isClosed()) return;
    if (error instanceof WebSocketClientMessageError) {
      sendError(socket, 400, {
        type: 'invalid_request_error',
        code: 'invalid_request_error',
        message: error.message,
      }, eventId);
      return;
    }
    sendError(socket, 500, serverErrorEnvelope(error), eventId);
  }
};

class WebSocketClientMessageError extends Error {}

const parseClientMessageData = (data: unknown): unknown => {
  const text = typeof data === 'string'
    ? data
    : data instanceof ArrayBuffer
      ? new TextDecoder().decode(data)
      : ArrayBuffer.isView(data)
        ? new TextDecoder().decode(data)
        : null;
  if (text === null) throw new WebSocketClientMessageError(`Unsupported WebSocket message data: ${typeof data}`);

  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new WebSocketClientMessageError(`WebSocket message must be valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
};

const validateClientMessage = (parsed: unknown): ResponsesWebSocketClientEvent => {
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
    throw new WebSocketClientMessageError('WebSocket message must be a JSON object with a string type.');
  }
  return parsed as ResponsesWebSocketClientEvent;
};

const responsesPayloadFromClientSource = (source: object): ResponsesPayload => {
  const candidate = source as { model?: unknown; input?: unknown };
  if (typeof candidate.model !== 'string' || candidate.model.length === 0) {
    throw new WebSocketClientMessageError('response.create requires response.model to be a non-empty string.');
  }
  if (typeof candidate.input !== 'string' && !Array.isArray(candidate.input)) {
    throw new WebSocketClientMessageError('response.create requires response.input to be a string or an array.');
  }
  return { ...source, stream: true } as ResponsesPayload;
};

const respondResponsesWebSocket = async (input: {
  readonly socket: WebSocket;
  readonly eventId: string | undefined;
  readonly signal: AbortSignal;
  readonly isClosed: () => boolean;
  readonly result: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> | PlainResult;
  readonly request: RequestContext;
}): Promise<boolean> => {
  const { socket, eventId, signal, isClosed, result, request } = input;
  if (result.type === 'upstream-error') {
    recordSourcePerformance(request, result.performance, true);
    sendError(socket, result.status, normalizeErrorBody(parseMaybeJson(result.body, result.headers), result.status), eventId);
    return false;
  }

  if (result.type === 'internal-error') {
    recordSourcePerformance(request, result.performance, true);
    sendError(socket, result.status, internalErrorEnvelope(result.error), eventId);
    return false;
  }

  if (result.type === 'plain') {
    if (result.status >= 400) sendError(socket, result.status, normalizeErrorBody(parseMaybeJson(result.body, result.headers), result.status), eventId);
    else sendJson(socket, parseMaybeJson(result.body, result.headers), eventId);
    return result.status < 400;
  }

  const state = new SourceStreamState();
  let completion: StreamCompletion = 'error';
  try {
    for await (const frame of result.events) {
      if (signal.aborted || isClosed()) {
        completion = 'cancel';
        return true;
      }
      if (frame.type !== 'event') continue;

      const event = frame.event;
      const failed = event.type === 'error' || event.type === 'response.failed';
      if (failed) state.failed = true;
      state.rememberUsage('response' in event ? tokenUsageFromResponsesResult((event as { response: ResponsesResult }).response) : null);

      if (isResponsesTerminalEvent(event)) {
        if (!sendJson(socket, event, eventId)) {
          completion = 'cancel';
          return true;
        }
        const done = responseDoneSummary(event);
        if (!failed) state.completed = true;
        if (done !== null && !sendJson(socket, { type: 'response.done', response: done }, eventId)) {
          completion = 'cancel';
          return true;
        }
        completion = 'eof';
        return true;
      }

      if (!sendJson(socket, event, eventId)) {
        completion = 'cancel';
        return true;
      }
    }

    throw new Error(RESPONSES_MISSING_TERMINAL_MESSAGE);
  } catch (error) {
    if (signal.aborted || isClosed()) {
      completion = 'cancel';
      return true;
    }
    state.failed = true;
    sendError(socket, 500, serverErrorEnvelope(error), eventId);
    return false;
  } finally {
    const metadata = await eventResultMetadata(result);
    try {
      await recordSourceUsage(request, metadata.modelIdentity, state.usage);
    } catch (error) {
      console.error('Failed to record Responses WebSocket usage:', error);
    } finally {
      recordSourcePerformance(request, metadata.performance, state.failedAfter(completion));
    }
  }
};

const parseMaybeJson = (body: Uint8Array, headers: Headers): unknown => {
  const text = new TextDecoder().decode(body);
  if (!(headers.get('content-type') ?? '').includes('application/json')) return { message: text };
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
};

const internalErrorEnvelope = (error: Extract<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>, { type: 'internal-error' }>['error']): Record<string, unknown> => ({
  type: error.type,
  code: error.type,
  name: error.name,
  message: error.message,
  stack: error.stack,
  cause: error.cause,
  source_api: error.source_api,
  target_api: error.target_api,
});

const serverErrorEnvelope = (error: unknown): Record<string, unknown> => ({
  ...toInternalDebugError(error, 'responses'),
  code: 'internal_error',
});

const tokenUsageFromResponsesResult = (response: ResponsesResult) => {
  const usage = response.usage;
  if (!usage) return null;
  const cacheRead = usage.input_tokens_details?.cached_tokens ?? 0;
  return tokenUsage({
    input: usage.input_tokens - cacheRead,
    input_cache_read: cacheRead,
    output: usage.output_tokens,
  });
};

const responseDoneSummary = (event: unknown) => {
  if (!event || typeof event !== 'object') return null;
  const type = (event as { type?: unknown }).type;
  if (type !== 'response.completed' && type !== 'response.failed' && type !== 'response.incomplete') return null;
  const response = (event as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return null;
  const id = (response as { id?: unknown }).id;
  if (typeof id !== 'string') return null;
  const usage = (response as { usage?: ResponsesResult['usage'] }).usage;
  return usage === undefined ? { id } : { id, usage };
};

const normalizeErrorBody = (body: unknown, statusCode: number): Record<string, unknown> => {
  const source = body && typeof body === 'object' && 'error' in body && typeof (body as { error?: unknown }).error === 'object'
    ? (body as { error: Record<string, unknown> }).error
    : body && typeof body === 'object'
      ? body as Record<string, unknown>
      : {};
  const type = typeof source.type === 'string'
    ? source.type
    : statusCode >= 500 ? 'server_error' : 'invalid_request_error';
  const message = typeof source.message === 'string'
    ? source.message
    : `Responses request failed with status ${statusCode}.`;
  return {
    ...source,
    type,
    code: typeof source.code === 'string' ? source.code : type,
    message,
  };
};

const sendError = (socket: WebSocket, statusCode: number, error: Record<string, unknown>, eventId?: string): void => {
  sendJson(socket, { type: 'error', status_code: statusCode, error }, eventId);
};

const sendJson = (socket: WebSocket, value: unknown, eventId?: string): boolean => {
  if (socket.readyState !== WebSocket.OPEN) return false;
  const payload = eventId === undefined || !value || typeof value !== 'object'
    ? value
    : { ...value, event_id: eventId };
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
};
