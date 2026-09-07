import { describe, expect, it } from 'vitest';

import { createWebSocketConnector } from '../../src/dial/fetcher.ts';
import { InMemoryRepo } from '../repo/memory.ts';
import { WebSocketUpgradeError } from '@floway-dev/http';
import type { WebSocketConnection } from '@floway-dev/http';
import { ProxyDialError } from '@floway-dev/proxy';
import type { SocketDial } from '@floway-dev/proxy';

const socketDial: SocketDial = {
  connect: async () => { throw new Error('not reached'); },
};

const connection = (): WebSocketConnection => ({
  readable: new ReadableStream(),
  writable: new WritableStream(),
  protocol: '',
  closed: Promise.resolve({ code: 1000, reason: '', wasClean: true }),
  close: async () => {},
});

const streamHarness = () => {
  let response!: ReadableStreamDefaultController<Uint8Array>;
  let written = new Uint8Array();
  const stream = {
    readable: new ReadableStream<Uint8Array>({ start(controller) { response = controller; } }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        const combined = new Uint8Array(written.byteLength + chunk.byteLength);
        combined.set(written);
        combined.set(chunk, written.byteLength);
        written = combined;
      },
    }),
  };
  return {
    stream,
    written: () => written,
    respond: (bytes: string | Uint8Array) => response.enqueue(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes),
  };
};

const completeUpgrade = async (harness: ReturnType<typeof streamHarness>): Promise<void> => {
  let request = '';
  while (!request.includes('\r\n\r\n')) {
    await new Promise(resolve => setTimeout(resolve, 0));
    request = new TextDecoder().decode(harness.written());
  }
  const key = /Sec-WebSocket-Key: ([^\r]+)\r\n/.exec(request)?.[1];
  if (key === undefined) throw new Error('WebSocket key missing');
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`));
  const accept = btoa(String.fromCharCode(...new Uint8Array(digest)));
  harness.respond([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'));
};

const baseInput = (repo: InMemoryRepo) => ({
  repo,
  upstreamId: 'u',
  fallbackList: [{ id: 'proxy' }, { id: 'direct_fetch' }],
  runtimeLocation: 'TEST',
  proxyById: new Map([['proxy', {
    config: { kind: 'socks5' as const, host: 'proxy.example', port: 1080, name: 'proxy' },
    dialTimeoutMs: null,
  }]]),
  openDirectStream: async () => { throw new ProxyDialError('not reached', 'tcp-connect'); },
  socketDial: () => socketDial,
});

describe('createWebSocketConnector', () => {
  it('uses the same backed-off first-pass ordering as HTTP fetches', async () => {
    const repo = new InMemoryRepo();
    await repo.proxyBackoffs.recordDialFailure('proxy', 'u', 'offline');
    const order: string[] = [];
    const connector = createWebSocketConnector({
      ...baseInput(repo),
      openProxiedStream: async () => {
        order.push('proxy');
        throw new ProxyDialError('still offline', 'tcp-connect');
      },
      runDirectWebSocket: () => async () => {
        order.push('direct');
        return connection();
      },
    });
    await connector('wss://chat.example/hub');
    expect(order).toEqual(['direct']);
  });

  it('advances after a pre-upgrade proxy dial failure and preserves URL target fields', async () => {
    const repo = new InMemoryRepo();
    const order: string[] = [];
    const connector = createWebSocketConnector({
      ...baseInput(repo),
      openProxiedStream: async () => {
        order.push('proxy');
        throw new ProxyDialError('connect failed', 'tcp-connect');
      },
      runDirectWebSocket: () => async (url, options) => {
        order.push('direct');
        expect(url).toBe('wss://chat.example/hub?access_token=secret');
        expect(options?.headers).toEqual([['Origin', 'https://m365.cloud.microsoft']]);
        return connection();
      },
    });
    await connector('wss://chat.example/hub?access_token=secret', {
      headers: [['Origin', 'https://m365.cloud.microsoft']],
    });
    expect(order).toEqual(['proxy', 'direct']);
  });

  it('does not advance after an upstream rejected the direct-fetch upgrade', async () => {
    const repo = new InMemoryRepo();
    let directConnectCalls = 0;
    const connector = createWebSocketConnector({
      ...baseInput(repo),
      fallbackList: [{ id: 'direct_fetch' }, { id: 'direct_connect' }],
      openProxiedStream: async () => { throw new Error('not reached'); },
      runDirectWebSocket: () => async () => {
        throw new WebSocketUpgradeError('upgrade replied 403');
      },
      openDirectStream: async () => {
        directConnectCalls += 1;
        throw new Error('not reached');
      },
    });
    await expect(connector('wss://chat.example/hub')).rejects.toBeInstanceOf(WebSocketUpgradeError);
    expect(directConnectCalls).toBe(0);
  });

  it('parses the socket-backed target without exposing the secret query to dial errors', async () => {
    const repo = new InMemoryRepo();
    const connector = createWebSocketConnector({
      ...baseInput(repo),
      fallbackList: [{ id: 'direct_connect' }],
      openProxiedStream: async () => { throw new Error('not reached'); },
      runDirectWebSocket: () => async () => connection(),
      openDirectStream: async target => {
        expect(target).toEqual({ host: '2001:db8::1', port: 8443, tls: true });
        throw new ProxyDialError('dial failed', 'tcp-connect');
      },
    });
    const error = await connector('wss://[2001:db8::1]:8443/hub?access_token=secret').catch(value => value);
    expect(error).toBeInstanceOf(ProxyDialError);
    expect(String(error)).not.toContain('secret');
  });

  it('forwards maxQueuedBytes to direct-connect message framing', async () => {
    const repo = new InMemoryRepo();
    const harness = streamHarness();
    const connector = createWebSocketConnector({
      ...baseInput(repo),
      fallbackList: [{ id: 'direct_connect' }],
      openProxiedStream: async () => { throw new Error('not reached'); },
      runDirectWebSocket: () => async () => connection(),
      openDirectStream: async () => harness.stream,
    });
    const opening = connector('wss://chat.example/hub', { maxQueuedBytes: 2 });
    await completeUpgrade(harness);
    const socket = await opening;
    harness.respond(new Uint8Array([0x81, 0x03, 0x61, 0x62, 0x63]));
    await expect(socket.readable.getReader().read()).rejects.toThrow('inbound queue exceeds 2 bytes');
  });
});
