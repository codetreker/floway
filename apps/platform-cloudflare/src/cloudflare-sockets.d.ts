// Hand-rolled ambient declaration for the surface this app uses from cloudflare:sockets; @cloudflare/workers-types does not yet ship it.
declare module 'cloudflare:sockets' {
  interface CloudflareSocket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    readonly closed: Promise<void>;
    /** Resolves when the underlying TCP / TLS handshake has finished;
     *  rejects with the connect / handshake error otherwise. */
    readonly opened: Promise<void>;
    close(): Promise<void>;
  }
  interface SocketAddress {
    hostname: string;
    port: number;
  }
  interface SocketOptions {
    allowHalfOpen: boolean;
    secureTransport?: 'off' | 'on';
  }
  export const connect: (address: SocketAddress, options?: SocketOptions) => CloudflareSocket;
}
