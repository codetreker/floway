// Public type surface for proxy-dial.
//
// The dial layer is transport-only. `DialTarget` describes WHERE to land
// after the proxy hop completes — host + port — and nothing else. TLS,
// SNI, ALPN, and HTTP-shaped concerns live one layer up in the
// orchestrator (runProxiedRequest).

import { ProxyDialError } from './errors.ts';

/** Pure transport target: where the proxy should land us. */
export interface DialTarget {
  /**
   * TCP host the proxy should reach on our behalf. Can be a hostname (resolved
   * by the proxy's resolver) or a literal IPv4/IPv6 address.
   *
   * MUST be ASCII. Callers are responsible for punycoding IDN labels before
   * the dial layer sees them — the wire format for every proxy protocol we
   * support either frames the hostname as length-prefixed bytes (SOCKS-style
   * ATYP-domain for SOCKS5 / SS / SS2022 / Trojan / VLESS) or embeds it raw
   * in an ASCII request line (HTTP CONNECT); a raw UTF-8 IDN would muddle
   * Latin-1 / UTF-8 framing in the former and break the ASCII grammar in the
   * latter. Dialers reject non-ASCII hosts up-front with a typed dial error.
   *
   * IPv6 literals: pass the bare address without `[…]` brackets — the proxy
   * library does not normalise the envelope, and downstream Host-header synth
   * re-adds the brackets when pushing the host back into a uri-host context.
   * `URL#hostname` keeps the brackets on IPv6 literals, so callers building a
   * DialTarget from a parsed URL must strip them first.
   */
  host: string;
  /** TCP port. */
  port: number;
}

/**
 * Reject a port outside the 1..65535 range used by TCP. Port 0 is
 * reserved (RFC 6335 §6) — its presence on the wire is almost always
 * a config bug. We surface a typed dial error at stage 'config' before
 * any I/O so the fallback chain can advance to the next proxy entry
 * without burning a TCP slot. */
export const assertValidTargetPort = (port: number, protocol: string): void => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProxyDialError(`${protocol}: target port must be 1..65535, got ${port}`, 'config');
  }
};

/**
 * Enforce the `DialTarget.host` ASCII + non-empty contract before any I/O.
 * Also reject the C0 control set (NUL, CR, LF, the rest of 0x00-0x1F),
 * SP, and DEL: a host containing one of those bytes that flows into the
 * HTTP CONNECT request line as `${target.host}:${target.port}` would
 * split the request line and inject a forged head onto the wire. Length-
 * prefixed dialers are not exposed to that smuggling shape, but
 * centralizing the byte filter here lets every dialer inherit the same
 * defense.
 *
 * SOCKS-style ATYP-domain framing carries the host as a 1-byte length-
 * prefix + bytes, so callers wiring those protocols pass `maxBytes: 255`.
 * Rejecting here surfaces as 'config' before any TCP slot is burned,
 * instead of masquerading mid-dial as a proxy-handshake error on an empty
 * length-prefixed domain, an over-long domain, or a `CONNECT :PORT`
 * request line. */
export const assertValidTargetHost = (
  host: string,
  protocol: string,
  opts?: { maxBytes?: number },
): void => {
  if (host.length === 0) {
    throw new ProxyDialError(`${protocol}: target host is empty`, 'config');
  }
  for (let i = 0; i < host.length; i++) {
    const c = host.charCodeAt(i);
    if (c > 0x7f) {
      throw new ProxyDialError(
        `${protocol}: target host must be ASCII (punycode IDN before dial): ${host}`,
        'config',
      );
    }
    if (c < 0x21 || c === 0x7f) {
      throw new ProxyDialError(
        `${protocol}: target host contains a forbidden byte 0x${c.toString(16).padStart(2, '0')}`,
        'config',
      );
    }
  }
  // ASCII-only above guarantees 1-byte-per-char UTF-8, so host.length is
  // both the char count and the encoded byte count.
  if (opts?.maxBytes !== undefined && host.length > opts.maxBytes) {
    throw new ProxyDialError(
      `${protocol}: target host too long (${host.length} bytes; ATYP domain is 1-byte length-prefixed, max ${opts.maxBytes})`,
      'config',
    );
  }
};

/**
 * Request-time target for the orchestrator: a DialTarget plus the
 * inner-TLS parameters needed to wrap the post-dial stream.
 *
 * Defaults flow `host → sni → verifyHost`. Override any one slot for
 * use cases like:
 *
 *   - **Domain fronting**: `host` and `sni` point at the front
 *     (e.g. a CDN edge), the HTTP request's `Host:` carries the real
 *     upstream name.
 *   - **Dial-by-IP**: `host` is a literal IP, `sni` and `verifyHost`
 *     are the cert's hostname.
 *   - **SNI hiding**: `sni` is benign, `verifyHost` is internal.
 */
export interface ProxyRequestTarget extends DialTarget {
  /** Whether to wrap the post-proxy byte stream with TLS to the upstream. */
  tls: boolean;

  /**
   * TLS ClientHello `server_name` extension value. Defaults to `host`.
   * If `host` is an IP, set this explicitly — IPs in SNI are invalid.
   */
  sni?: string;

  /**
   * Hostname the upstream's certificate chain must prove. Defaults to
   * `sni` (which itself defaults to `host`).
   */
  verifyHost?: string;

  /** Optional ALPN protocol list for the inner TLS handshake. */
  alpn?: string[];
}

export interface SocketDial {
  connect(host: string, port: number, opts?: SocketDialOptions): Promise<DialedSocket>;
}

export interface DialedSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  /** Idempotent close. */
  close(): Promise<void>;
}

// Structurally identical to @floway-dev/platform's SocketDialOptions;
// duplicated rather than imported so @floway-dev/proxy stays runtime-
// agnostic and the platform's impl is assignable by structural typing.
interface SocketDialOptions {
  tls?: boolean;
  signal?: AbortSignal;
}

/**
 * Open a TCP socket and rewrap any failure as a typed `tcp-connect`
 * ProxyDialError. Every dialer's outer `socket = await socketDial.connect(…)`
 * needs the same wrap so the fallback chain sees a uniform discriminant —
 * this is that wrap, centralised.
 */
export const connectOrDialError = async (
  socketDial: SocketDial,
  host: string,
  port: number,
  opts?: SocketDialOptions,
): Promise<DialedSocket> => {
  try {
    return await socketDial.connect(host, port, opts);
  } catch (cause) {
    throw new ProxyDialError(`tcp connect to ${host}:${port} failed`, 'tcp-connect', { cause });
  }
};

/**
 * Output of a per-protocol `dial`. The duplex stream points at
 * `target.host:target.port` (after the proxy's framing has been peeled
 * off). `prefix`, when present, is bytes the dialer wants prepended to
 * the very first record the orchestrator emits next.
 */
export interface DialResult {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  prefix?: Uint8Array;
}

export interface DialOptions {
  /** Caller-supplied cancellation, threaded through every dial leg. */
  signal?: AbortSignal;
  /** Per-call dial-stage deadline override (ms). Falls back to
   *  DEFAULT_DIAL_DEADLINE_MS when absent. */
  dialTimeoutMs?: number;
  /**
   * Platform-injected raw TCP dial primitive. Required — every dialer
   * needs to open at least one TCP connection.
   */
  socketDial: SocketDial;
}
