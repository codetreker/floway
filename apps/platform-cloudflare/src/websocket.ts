import { nativeWebSocketConnection, signalAbortReason, validateWebSocketConnectOptions, WebSocketUpgradeError } from '@floway-dev/http';
import type { NativeWebSocketLike, WebSocketConnector } from '@floway-dev/http';

interface CloudflareOutboundWebSocket extends NativeWebSocketLike {
  accept(): void;
}

type WebSocketUpgradeResponse = Response & { readonly webSocket?: CloudflareOutboundWebSocket | null };

export const createCloudflareWebSocketConnector = (
  runtimeFetch: typeof fetch,
): WebSocketConnector => async (url, options = {}) => {
  if (options.signal?.aborted) throw signalAbortReason(options.signal);
  validateWebSocketConnectOptions(options);
  const parsed = new URL(url);
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  else throw new TypeError(`WebSocket URL must use ws: or wss:; got ${parsed.protocol}`);

  const headers = new Headers();
  for (const [name, value] of options.headers ?? []) headers.append(name, value);
  headers.set('Upgrade', 'websocket');
  if (options.subprotocols?.length) {
    headers.set('Sec-WebSocket-Protocol', options.subprotocols.join(', '));
  }
  const response = await runtimeFetch(parsed, {
    headers,
    signal: options.signal,
  }) as WebSocketUpgradeResponse;
  if (response.status !== 101 || response.webSocket === undefined || response.webSocket === null) {
    await response.body?.cancel().catch(() => {});
    throw new WebSocketUpgradeError(`WebSocket upgrade replied ${response.status} ${JSON.stringify(response.statusText)}`);
  }
  response.webSocket.accept();
  return nativeWebSocketConnection(response.webSocket, options);
};

export const cloudflareWebSocketConnector = createCloudflareWebSocketConnector(fetch);
