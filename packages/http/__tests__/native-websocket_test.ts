import { describe, expect, it } from 'vitest';

import { nativeWebSocketConnection } from '../src/native-websocket.ts';
import type { NativeWebSocketLike } from '../src/native-websocket.ts';

class FakeNativeWebSocket extends EventTarget {
  readonly protocol = 'chat';
  readonly readyState = 1;
  bufferedAmount = 0;
  binaryType = 'blob';
  readonly sent: (string | Uint8Array)[] = [];
  readonly closes: { code?: number; reason?: string }[] = [];

  send(data: string | Uint8Array): void {
    this.sent.push(typeof data === 'string' ? data : data.slice());
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  message(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  peerClose(code: number, reason: string, wasClean: boolean): void {
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason, wasClean }));
  }

  fail(error: Error): void {
    this.dispatchEvent(Object.assign(new Event('error'), error));
  }
}

class FakePausableNativeWebSocket extends FakeNativeWebSocket {
  pauseCalls = 0;
  resumeCalls = 0;

  pause(): void {
    this.pauseCalls += 1;
  }

  resume(): void {
    this.resumeCalls += 1;
  }
}

describe('nativeWebSocketConnection', () => {
  it('normalizes native messages and serializes outgoing text and binary', async () => {
    const native = new FakeNativeWebSocket();
    const socket = nativeWebSocketConnection(native as unknown as NativeWebSocketLike);
    expect(native.binaryType).toBe('arraybuffer');
    const reader = socket.readable.getReader();
    native.message('hello');
    await expect(reader.read()).resolves.toEqual({ done: false, value: { type: 'text', data: 'hello' } });
    native.message(new Uint8Array([1, 2]).buffer);
    const binary = await reader.read();
    expect(binary.value?.type).toBe('binary');
    if (binary.value?.type === 'binary') expect([...binary.value.data]).toEqual([1, 2]);

    const writer = socket.writable.getWriter();
    await writer.write({ type: 'text', data: 'out' });
    await writer.write({ type: 'binary', data: new Uint8Array([3]) });
    expect(native.sent).toEqual(['out', new Uint8Array([3])]);
  });

  it('preserves clean peer close metadata', async () => {
    const native = new FakeNativeWebSocket();
    const socket = nativeWebSocketConnection(native as unknown as NativeWebSocketLike);
    native.peerClose(1001, 'away', true);
    await expect(socket.closed).resolves.toEqual({ code: 1001, reason: 'away', wasClean: true });
    await expect(socket.readable.getReader().read()).resolves.toEqual({ done: true, value: undefined });
  });

  it('errors the readable and reports 1006 on native transport failure', async () => {
    const native = new FakeNativeWebSocket();
    const socket = nativeWebSocketConnection(native as unknown as NativeWebSocketLike);
    const read = socket.readable.getReader().read();
    native.fail(new Error('boom'));
    await expect(read).rejects.toThrow('WebSocket transport error');
    await expect(socket.closed).resolves.toEqual({ code: 1006, reason: '', wasClean: false });
  });

  it('closes and errors when a non-pausable inbound burst exceeds the byte queue cap', async () => {
    const native = new FakeNativeWebSocket();
    const socket = nativeWebSocketConnection(native as unknown as NativeWebSocketLike, { maxQueuedBytes: 4 });
    native.message('abc');
    native.message('de');

    await expect(socket.readable.getReader().read()).rejects.toThrow('inbound queue exceeds 4 bytes');
    expect(native.closes).toEqual([{ code: 1009, reason: 'inbound queue limit exceeded' }]);
    await expect(socket.closed).resolves.toEqual({
      code: 1009,
      reason: 'inbound queue limit exceeded',
      wasClean: false,
    });
  });

  it('pauses a pausable native socket at the byte high-water mark and resumes after consumption', async () => {
    const native = new FakePausableNativeWebSocket();
    const socket = nativeWebSocketConnection(native as unknown as NativeWebSocketLike, { maxQueuedBytes: 3 });
    native.message('abc');
    expect(native.pauseCalls).toBe(1);

    await expect(socket.readable.getReader().read()).resolves.toEqual({
      done: false,
      value: { type: 'text', data: 'abc' },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(native.resumeCalls).toBe(1);
  });
});
