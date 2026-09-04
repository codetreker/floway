import { DEFAULT_DIAL_DEADLINE_MS } from './constants.ts';
import { connectOrDialError } from './dial-target.ts';
import { dial } from './dialer.ts';
import { ProxyDialError } from './errors.ts';
import type { ProxyConfig } from './proxy-config.ts';
import type { DialOptions, DialResult, ProxyRequestTarget } from './types.ts';
import type { DuplexStream, TlsStream } from '@floway-dev/http';
import { signalAbortReason, userspaceTls } from '@floway-dev/http';

export type OpenApplicationStreamOptions = DialOptions;

export const openProxiedApplicationStream = async (
  config: ProxyConfig,
  target: ProxyRequestTarget,
  options: OpenApplicationStreamOptions,
): Promise<DuplexStream> => {
  const dialed = await dial(config, target, options);
  try {
    return await applicationStreamFromDialResult(dialed, target, options.signal);
  } catch (error) {
    void dialed.readable.cancel(error).catch(() => {});
    throw error;
  }
};

export const withDialDeadline = async <T>(
  options: DialOptions,
  timeoutError: () => ProxyDialError,
  run: (options: DialOptions) => Promise<T>,
): Promise<T> => {
  const deadlineMs = options.dialTimeoutMs ?? DEFAULT_DIAL_DEADLINE_MS;
  const callerSignal = options.signal;
  if (callerSignal?.aborted) throw signalAbortReason(callerSignal);
  const internal = new AbortController();
  const onCallerAbort = (): void => internal.abort(signalAbortReason(callerSignal!));
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => internal.abort(timeoutError()), deadlineMs);
  try {
    return await run({ ...options, signal: internal.signal });
  } catch (error) {
    if (internal.signal.aborted && internal.signal.reason instanceof ProxyDialError) {
      throw internal.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
};

export const openDirectApplicationStream = async (
  target: ProxyRequestTarget,
  options: DialOptions,
): Promise<DuplexStream> => {
  const deadlineMs = options.dialTimeoutMs ?? DEFAULT_DIAL_DEADLINE_MS;
  const socket = await withDialDeadline(
    options,
    () => new ProxyDialError(
      `direct-connect: dial to ${target.host}:${target.port} exceeded deadline of ${deadlineMs}ms`,
      'tcp-connect',
    ),
    innerOptions => connectOrDialError(
      innerOptions.socketDial,
      target.host,
      target.port,
      { signal: innerOptions.signal },
    ),
  );
  try {
    return await applicationStreamFromDialResult(socket, target, options.signal);
  } catch (error) {
    await socket.close().catch(() => {});
    throw error;
  }
};

export const applicationStreamFromDialResult = async (
  dialed: DialResult,
  target: ProxyRequestTarget,
  signal?: AbortSignal,
): Promise<DuplexStream> => {
  const stream: DuplexStream = { readable: dialed.readable, writable: dialed.writable };
  if (target.tls) {
    let tls: TlsStream;
    try {
      tls = await userspaceTls(stream, {
        host: target.sni ?? target.host,
        verifyHost: target.verifyHost ?? target.sni ?? target.host,
        alpn: target.alpn,
        prefix: dialed.prefix,
        signal,
      });
    } catch (cause) {
      if (cause instanceof ProxyDialError) throw cause;
      throw new ProxyDialError('inner tls handshake to upstream failed', 'inner-tls', { cause });
    }
    return tls;
  }
  if (dialed.prefix === undefined || dialed.prefix.byteLength === 0) return stream;
  return prependFirstWrite(stream, dialed.prefix);
};

const prependFirstWrite = (stream: DuplexStream, prefix: Uint8Array): DuplexStream => {
  const writer = stream.writable.getWriter();
  let pendingPrefix: Uint8Array | undefined = prefix;
  return {
    readable: stream.readable,
    writable: new WritableStream<Uint8Array>({
      async write(chunk) {
        if (pendingPrefix !== undefined) {
          const first = pendingPrefix;
          pendingPrefix = undefined;
          const combined = new Uint8Array(first.byteLength + chunk.byteLength);
          combined.set(first);
          combined.set(chunk, first.byteLength);
          await writer.write(combined);
          return;
        }
        await writer.write(chunk);
      },
      async close() {
        if (pendingPrefix !== undefined) {
          const first = pendingPrefix;
          pendingPrefix = undefined;
          await writer.write(first);
        }
        await writer.close();
      },
      async abort(reason) {
        pendingPrefix = undefined;
        await writer.abort(reason);
      },
    }),
  };
};
