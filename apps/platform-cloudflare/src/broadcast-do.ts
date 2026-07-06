import { DurableObject } from 'cloudflare:workers';

// `extends DurableObject` is load-bearing: the CF runtime gates RPC method
// dispatch (`stub.broadcast(...)`, `stub.closeAll(...)`) on the actor
// extending this base class. Without it the runtime rejects the call with
// "the receiving Durable Object does not support RPC" and any caller using
// direct method invocation silently fails.

export class BroadcastDO extends DurableObject {
  // Declared explicitly so the type-check sees `(ctx, env)` even when the
  // `cloudflare:workers` types resolve to a parameterless base.
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
  }

  async fetch(_request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async broadcast(payload: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.send(payload);
  }

  async closeAll(reason: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, reason);
  }

  // Hibernation hooks. With compatibility_date < 2026-04-07 the runtime
  // delivers close events only when these hooks are declared on the actor,
  // and `webSocketClose` must call `ws.close(code, reason)` to complete the
  // close handshake from the actor side — without it the client sees a
  // `1006 abnormal closure` and the actor holds the dead socket until the
  // hibernation timeout.
  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    ws.close(code, reason);
  }
  async webSocketError(_ws: WebSocket, _err: unknown): Promise<void> {}
}
