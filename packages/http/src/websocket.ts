import type { HttpHeaderLines } from './types.ts';

export type WebSocketMessage =
  | { readonly type: 'text'; readonly data: string }
  | { readonly type: 'binary'; readonly data: Uint8Array };

export interface WebSocketCloseInfo {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

export interface WebSocketConnection {
  readonly readable: ReadableStream<WebSocketMessage>;
  readonly writable: WritableStream<WebSocketMessage>;
  readonly protocol: string;
  readonly closed: Promise<WebSocketCloseInfo>;
  close(code?: number, reason?: string): Promise<void>;
}

export interface WebSocketConnectOptions {
  readonly headers?: HttpHeaderLines;
  readonly subprotocols?: readonly string[];
  readonly signal?: AbortSignal;
  readonly maxMessageBytes?: number;
  /** Maximum total bytes buffered for unread inbound messages. */
  readonly maxQueuedBytes?: number;
}

export type WebSocketConnector = (
  url: string,
  options?: WebSocketConnectOptions,
) => Promise<WebSocketConnection>;

export class WebSocketUpgradeError extends Error {
  override readonly name = 'WebSocketUpgradeError';
}

export const WEB_SOCKET_NORMAL_CLOSE = 1000;
export const WEB_SOCKET_ABNORMAL_CLOSE = 1006;

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const RESERVED_REQUEST_HEADERS = new Set([
  'host',
  'upgrade',
  'connection',
  'sec-websocket-version',
  'sec-websocket-key',
  'sec-websocket-protocol',
]);

export const validateWebSocketConnectOptions = (options: WebSocketConnectOptions): void => {
  const maxMessageBytes = options.maxMessageBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0) {
    throw new RangeError(`maxMessageBytes must be a positive safe integer; got ${maxMessageBytes}`);
  }
  const maxQueuedBytes = options.maxQueuedBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes <= 0) {
    throw new RangeError(`maxQueuedBytes must be a positive safe integer; got ${maxQueuedBytes}`);
  }
  for (const protocol of options.subprotocols ?? []) {
    if (!TOKEN.test(protocol)) throw new TypeError(`WebSocket subprotocol is not a valid token: ${JSON.stringify(protocol)}`);
  }
  for (const [name, value] of options.headers ?? []) {
    if (!TOKEN.test(name)) throw new TypeError(`WebSocket header name is not a valid token: ${JSON.stringify(name)}`);
    if (RESERVED_REQUEST_HEADERS.has(name.toLowerCase())) {
      throw new TypeError(`Caller cannot override reserved WebSocket header ${JSON.stringify(name)}`);
    }
    if (/[^\t\x20-\x7e\x80-\xff]/.test(value)) {
      throw new TypeError(`WebSocket header value for ${JSON.stringify(name)} contains a forbidden control character`);
    }
  }
};

export const validateWebSocketClose = (code: number, reason: string): Uint8Array => {
  if (code < 1000 || code >= 5000 || code === 1004 || code === 1005 || code === 1006 || code === 1015) {
    throw new RangeError(`WebSocket close code is not valid on the wire; got ${code}`);
  }
  const reasonBytes = new TextEncoder().encode(reason);
  if (reasonBytes.byteLength > 123) {
    throw new RangeError(`WebSocket close reason exceeds 123 UTF-8 bytes; got ${reasonBytes.byteLength}`);
  }
  const payload = new Uint8Array(2 + reasonBytes.byteLength);
  payload[0] = code >>> 8;
  payload[1] = code & 0xff;
  payload.set(reasonBytes, 2);
  return payload;
};
