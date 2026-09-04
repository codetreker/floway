import { signalAbortReason } from './abort.ts';
import { WEB_SOCKET_ABNORMAL_CLOSE, WEB_SOCKET_NORMAL_CLOSE, validateWebSocketClose } from './websocket.ts';
import type { WebSocketCloseInfo, WebSocketConnection, WebSocketMessage } from './websocket.ts';

interface NativeMessageEvent { readonly data: unknown }
interface NativeCloseEvent { readonly code: number; readonly reason: string; readonly wasClean: boolean }

export interface NativeWebSocketLike {
  readonly protocol: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', listener: (event: NativeMessageEvent) => void): void;
  addEventListener(type: 'close', listener: (event: NativeCloseEvent) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  removeEventListener(type: 'message', listener: (event: NativeMessageEvent) => void): void;
  removeEventListener(type: 'close', listener: (event: NativeCloseEvent) => void): void;
  removeEventListener(type: 'error', listener: (event: unknown) => void): void;
  pause?(): void;
  resume?(): void;
}

export interface NativeWebSocketConnectionOptions {
  readonly signal?: AbortSignal;
  readonly maxMessageBytes?: number;
  readonly maxQueuedBytes?: number;
  readonly maxBufferedBytes?: number;
}

const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;

export const nativeWebSocketConnection = (
  socket: NativeWebSocketLike,
  options: NativeWebSocketConnectionOptions = {},
): WebSocketConnection => {
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0) {
    throw new RangeError(`maxMessageBytes must be a positive safe integer; got ${maxMessageBytes}`);
  }
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes <= 0) {
    throw new RangeError(`maxBufferedBytes must be a positive safe integer; got ${maxBufferedBytes}`);
  }
  if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes <= 0) {
    throw new RangeError(`maxQueuedBytes must be a positive safe integer; got ${maxQueuedBytes}`);
  }

  socket.binaryType = 'arraybuffer';
  let controller!: ReadableStreamDefaultController<WebSocketMessage>;
  let terminal = false;
  let paused = false;
  let settleClosed!: (info: WebSocketCloseInfo) => void;
  const closed = new Promise<WebSocketCloseInfo>(resolve => { settleClosed = resolve; });

  const detach = (): void => {
    socket.removeEventListener('message', onMessage);
    socket.removeEventListener('close', onClose);
    socket.removeEventListener('error', onError);
    options.signal?.removeEventListener('abort', onAbort);
  };
  const finish = (info: WebSocketCloseInfo, error?: unknown): void => {
    if (terminal) return;
    terminal = true;
    detach();
    settleClosed(info);
    if (error !== undefined) controller.error(error);
    else controller.close();
  };
  const onMessage = (event: NativeMessageEvent): void => {
    try {
      const message = nativeMessage(event.data);
      const bytes = messageByteLength(message);
      if (bytes > maxMessageBytes) {
        throw new RangeError(`WebSocket message exceeds ${maxMessageBytes} bytes`);
      }
      const queuedSize = Math.max(1, bytes);
      const available = controller.desiredSize ?? 0;
      if (queuedSize > maxQueuedBytes || queuedSize > available) {
        const error = new RangeError(`WebSocket inbound queue exceeds ${maxQueuedBytes} bytes`);
        try { socket.close(1009, 'inbound queue limit exceeded'); } catch { /* already closed */ }
        finish({ code: 1009, reason: 'inbound queue limit exceeded', wasClean: false }, error);
        return;
      }
      controller.enqueue(message);
      if ((controller.desiredSize ?? 0) <= 0 && socket.pause !== undefined) {
        paused = true;
        socket.pause();
      }
    } catch (error) {
      try { socket.close(1009, 'message too large or unsupported'); } catch { /* already closed */ }
      finish({ code: WEB_SOCKET_ABNORMAL_CLOSE, reason: '', wasClean: false }, error);
    }
  };
  const onClose = (event: NativeCloseEvent): void => {
    const info = { code: event.code, reason: event.reason, wasClean: event.wasClean };
    const error = event.wasClean
      ? undefined
      : new Error(`WebSocket closed abnormally (${event.code}${event.reason ? `: ${event.reason}` : ''})`);
    finish(info, error);
  };
  const onError = (event: unknown): void => {
    const nested = typeof event === 'object' && event !== null && 'error' in event
      ? (event as { readonly error?: unknown }).error
      : undefined;
    const error = event instanceof Error
      ? event
      : nested instanceof Error
        ? nested
        : new Error('WebSocket transport error', { cause: event });
    finish({ code: WEB_SOCKET_ABNORMAL_CLOSE, reason: '', wasClean: false }, error);
  };
  const onAbort = (): void => {
    const error = signalAbortReason(options.signal!);
    try { socket.close(1000, 'aborted'); } catch { /* already closed */ }
    finish({ code: WEB_SOCKET_ABNORMAL_CLOSE, reason: '', wasClean: false }, error);
  };

  const readable = new ReadableStream<WebSocketMessage>({
    start(value) { controller = value; },
    pull() {
      if (paused) {
        paused = false;
        socket.resume?.();
      }
    },
    cancel(reason) {
      try { socket.close(WEB_SOCKET_NORMAL_CLOSE, reason instanceof Error ? '' : String(reason ?? '')); } catch { /* already closed */ }
      finish({ code: WEB_SOCKET_NORMAL_CLOSE, reason: '', wasClean: true });
    },
  }, {
    highWaterMark: maxQueuedBytes,
    size: message => Math.max(1, messageByteLength(message)),
  });

  socket.addEventListener('message', onMessage);
  socket.addEventListener('close', onClose);
  socket.addEventListener('error', onError);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  const waitForBackpressure = async (): Promise<void> => {
    while (!terminal && socket.bufferedAmount > maxBufferedBytes) {
      await new Promise<void>(resolve => setTimeout(resolve, 1));
    }
    if (terminal) throw new Error('WebSocket is closed');
  };
  const writable = new WritableStream<WebSocketMessage>({
    async write(message) {
      const data = message.type === 'text' ? message.data : message.data;
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
      if (bytes > maxMessageBytes) throw new RangeError(`WebSocket message exceeds ${maxMessageBytes} bytes`);
      await waitForBackpressure();
      socket.send(data);
      await waitForBackpressure();
    },
    close() {
      validateWebSocketClose(WEB_SOCKET_NORMAL_CLOSE, '');
      socket.close(WEB_SOCKET_NORMAL_CLOSE, '');
    },
    abort(reason) {
      const closeReason = reason instanceof Error ? reason.message : String(reason ?? '');
      const reasonText = truncateUtf8(closeReason, 123);
      socket.close(1011, reasonText);
    },
  });

  return {
    readable,
    writable,
    protocol: socket.protocol,
    closed,
    async close(code = WEB_SOCKET_NORMAL_CLOSE, reason = '') {
      validateWebSocketClose(code, reason);
      socket.close(code, reason);
    },
  };
};

const truncateUtf8 = (value: string, maxBytes: number): string => {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
};

const messageByteLength = (message: WebSocketMessage): number =>
  message.type === 'text' ? new TextEncoder().encode(message.data).byteLength : message.data.byteLength;

const nativeMessage = (data: unknown): WebSocketMessage => {
  if (typeof data === 'string') return { type: 'text', data };
  if (data instanceof ArrayBuffer) return { type: 'binary', data: new Uint8Array(data) };
  if (ArrayBuffer.isView(data)) {
    return { type: 'binary', data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() };
  }
  if (Array.isArray(data) && data.every(value => ArrayBuffer.isView(value))) {
    const views = data as ArrayBufferView[];
    const size = views.reduce((total, value) => total + value.byteLength, 0);
    const result = new Uint8Array(size);
    let offset = 0;
    for (const value of views) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      result.set(bytes, offset);
      offset += bytes.byteLength;
    }
    return { type: 'binary', data: result };
  }
  throw new TypeError(`Unsupported native WebSocket message data: ${Object.prototype.toString.call(data)}`);
};
