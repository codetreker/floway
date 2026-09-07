import { sha1 } from '@noble/hashes/legacy.js';
import { describe, expect, it } from 'vitest';

import { makeFakeDuplex } from './test-utils.ts';
import { connectWebSocketOnStream } from '../src/ws-upgrade.ts';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const enc = (value: string): Uint8Array => new TextEncoder().encode(value);
const dec = (value: Uint8Array): string => new TextDecoder().decode(value);
const base64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const requestKey = (request: Uint8Array): string => {
  const match = dec(request).match(/Sec-WebSocket-Key: ([^\r]+)\r\n/);
  if (match === null) throw new Error('WebSocket key missing');
  return match[1]!;
};
const handshake = (key: string, protocol?: string): string => [
  'HTTP/1.1 101 Switching Protocols',
  'Upgrade: websocket',
  'Connection: Upgrade',
  `Sec-WebSocket-Accept: ${base64(sha1(enc(key + WS_GUID)))}`,
  ...(protocol === undefined ? [] : [`Sec-WebSocket-Protocol: ${protocol}`]),
  '',
  '',
].join('\r\n');
const completeHandshake = async (fake: ReturnType<typeof makeFakeDuplex>, protocol?: string): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
  fake.respond(handshake(requestKey(fake.written()), protocol));
};
const serverFrame = (opcode: number, payload: Uint8Array, fin = true): Uint8Array => {
  if (payload.byteLength > 125) throw new Error('test helper only supports short frames');
  return new Uint8Array([(fin ? 0x80 : 0) | opcode, payload.byteLength, ...payload]);
};
const clientFrame = (bytes: Uint8Array): { opcode: number; payload: Uint8Array; consumed: number } | null => {
  if (bytes.byteLength < 6) return null;
  const opcode = bytes[0]! & 0x0f;
  const length = bytes[1]! & 0x7f;
  if (length > 125 || bytes.byteLength < 6 + length) return null;
  const mask = bytes.subarray(2, 6);
  const payload = new Uint8Array(length);
  for (let index = 0; index < length; index++) payload[index] = bytes[6 + index]! ^ mask[index & 3]!;
  return { opcode, payload, consumed: 6 + length };
};
const readClientFrame = async (fake: ReturnType<typeof makeFakeDuplex>, offset: number) => {
  while (true) {
    const frame = clientFrame(fake.written().subarray(offset));
    if (frame !== null) return { frame, offset: offset + frame.consumed };
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

describe('connectWebSocketOnStream', () => {
  it('preserves text and binary message types, including fragmented UTF-8', async () => {
    const fake = makeFakeDuplex();
    const opening = connectWebSocketOnStream(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const socket = await opening;
    const text = enc('a¢b');
    fake.respond(serverFrame(0x1, text.subarray(0, 2), false));
    fake.respond(serverFrame(0x0, text.subarray(2)));
    fake.respond(serverFrame(0x2, enc('bytes')));
    const reader = socket.readable.getReader();
    await expect(reader.read()).resolves.toEqual({ done: false, value: { type: 'text', data: 'a¢b' } });
    const binary = await reader.read();
    expect(binary.value?.type).toBe('binary');
    if (binary.value?.type === 'binary') expect(dec(binary.value.data)).toBe('bytes');
  });

  it('rejects invalid UTF-8 text', async () => {
    const fake = makeFakeDuplex();
    const opening = connectWebSocketOnStream(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const socket = await opening;
    fake.respond(serverFrame(0x1, new Uint8Array([0xc3, 0x28])));
    await expect(socket.readable.getReader().read()).rejects.toMatchObject({ code: 'BAD_HEADERS' });
  });

  it('writes text, binary, and empty messages with matching opcodes', async () => {
    const fake = makeFakeDuplex();
    const opening = connectWebSocketOnStream(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const socket = await opening;
    const offset = fake.written().byteLength;
    const writer = socket.writable.getWriter();
    await writer.write({ type: 'text', data: '' });
    await writer.write({ type: 'binary', data: enc('b') });
    const text = await readClientFrame(fake, offset);
    const binary = await readClientFrame(fake, text.offset);
    expect(text.frame.opcode).toBe(0x1);
    expect(text.frame.payload).toHaveLength(0);
    expect(binary.frame.opcode).toBe(0x2);
    expect(dec(binary.frame.payload)).toBe('b');
  });

  it('exposes selected protocol and clean peer close metadata', async () => {
    const fake = makeFakeDuplex();
    const opening = connectWebSocketOnStream(fake, { host: 'h', path: '/', subprotocols: ['chat'] });
    await completeHandshake(fake, 'chat');
    const socket = await opening;
    expect(socket.protocol).toBe('chat');
    fake.respond(serverFrame(0x8, new Uint8Array([0x03, 0xe9, ...enc('away')])));
    await expect(socket.closed).resolves.toEqual({ code: 1001, reason: 'away', wasClean: true });
  });

  it('reports EOF without a close frame as abnormal closure', async () => {
    const fake = makeFakeDuplex();
    const opening = connectWebSocketOnStream(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const socket = await opening;
    const read = socket.readable.getReader().read();
    fake.endResponse();
    await expect(read).rejects.toMatchObject({ code: 'EOF' });
    await expect(socket.closed).resolves.toEqual({ code: 1006, reason: '', wasClean: false });
  });

  it('validates message limits and subprotocols before writing', async () => {
    const size = makeFakeDuplex();
    await expect(connectWebSocketOnStream(size, { host: 'h', path: '/', maxMessageBytes: 0 })).rejects.toBeInstanceOf(RangeError);
    expect(size.written()).toHaveLength(0);
    const protocol = makeFakeDuplex();
    await expect(connectWebSocketOnStream(protocol, { host: 'h', path: '/', subprotocols: ['chat\r\nEvil: yes'] }))
      .rejects.toMatchObject({ code: 'BAD_HEADERS' });
    expect(protocol.written()).toHaveLength(0);
  });

  it('enforces the byte queue cap on stream-backed messages', async () => {
    const fake = makeFakeDuplex();
    const opening = connectWebSocketOnStream(fake, { host: 'h', path: '/', maxQueuedBytes: 2 });
    await completeHandshake(fake);
    const socket = await opening;
    fake.respond(serverFrame(0x1, enc('abc')));
    await expect(socket.readable.getReader().read()).rejects.toThrow('inbound queue exceeds 2 bytes');
    await expect(socket.closed).resolves.toEqual({ code: 1006, reason: '', wasClean: false });
  });

  it('forces teardown when unread data prevents the peer close from being processed', async () => {
    const fake = makeFakeDuplex();
    const opening = connectWebSocketOnStream(fake, {
      host: 'h',
      path: '/',
      maxQueuedBytes: 3,
      closeHandshakeTimeoutMs: 20,
    });
    await completeHandshake(fake);
    const socket = await opening;
    fake.respond(serverFrame(0x1, enc('abc')));
    fake.respond(serverFrame(0x1, enc('de')));
    fake.respond(serverFrame(0x8, new Uint8Array([0x03, 0xe8])));
    await socket.close();

    await fake.waitWritableClosed();
    await expect(socket.closed).resolves.toEqual({ code: 1006, reason: '', wasClean: false });
    await expect(socket.readable.getReader().read()).rejects.toThrow('close handshake exceeded 20ms');
  });
});
