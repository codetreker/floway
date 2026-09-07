import WebSocket from 'ws';

import { nativeWebSocketConnection, signalAbortReason, validateWebSocketConnectOptions, WebSocketUpgradeError } from '@floway-dev/http';
import type { NativeWebSocketLike, WebSocketConnector } from '@floway-dev/http';

export const nodeWebSocketConnector: WebSocketConnector = async (url, options = {}) => {
  if (options.signal?.aborted) throw signalAbortReason(options.signal);
  validateWebSocketConnectOptions(options);
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of options.headers ?? []) {
    const current = headers[name];
    if (current === undefined) headers[name] = value;
    else if (Array.isArray(current)) current.push(value);
    else headers[name] = [current, value];
  }

  const socket = new WebSocket(url, [...options.subprotocols ?? []], {
    headers,
    maxPayload: options.maxMessageBytes,
    perMessageDeflate: false,
  });
  const connection = nativeWebSocketConnection(socket as unknown as NativeWebSocketLike, options);

  await new Promise<void>((resolve, reject) => {
    const detach = (): void => {
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('unexpected-response', onUnexpectedResponse);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const onOpen = (): void => {
      detach();
      resolve();
    };
    const onError = (error: Error): void => {
      detach();
      const code = (error as NodeJS.ErrnoException).code;
      reject(code === undefined ? new WebSocketUpgradeError(error.message, { cause: error }) : error);
    };
    const onUnexpectedResponse = (_request: unknown, response: { statusCode?: number; statusMessage?: string }): void => {
      detach();
      socket.terminate();
      reject(new WebSocketUpgradeError(`WebSocket upgrade replied ${response.statusCode ?? 0} ${JSON.stringify(response.statusMessage ?? '')}`));
    };
    const onAbort = (): void => {
      detach();
      socket.terminate();
      reject(signalAbortReason(options.signal!));
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('unexpected-response', onUnexpectedResponse);
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
  return connection;
};
