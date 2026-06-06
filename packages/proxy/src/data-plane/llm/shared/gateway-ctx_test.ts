import { Hono } from 'hono';
import { describe, test } from 'vitest';

import { createGatewayCtxFromHono, createGatewayCtxForWs } from './gateway-ctx.ts';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

describe('createGatewayCtxFromHono', () => {
  test('copies auth fields when both are set', async () => {
    const app = new Hono<{ Variables: { apiKeyId: string; apiKeyUpstreamIds: readonly string[] } }>();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      c.set('apiKeyId', 'key-1');
      c.set('apiKeyUpstreamIds', ['up-1', 'up-2']);
      ctx = createGatewayCtxFromHono(c, true);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.apiKeyId, 'key-1');
    assertEquals(ctx.apiKeyUpstreamIds, ['up-1', 'up-2']);
  });

  test('sets apiKeyId and apiKeyUpstreamIds to null when unset (admin key path)', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, false);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.apiKeyId, null);
    assertEquals(ctx.apiKeyUpstreamIds, null);
  });

  test('respects wantsStream=true', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, true);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.wantsStream, true);
  });

  test('respects wantsStream=false', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, false);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.wantsStream, false);
  });

  test('wantsStream=true: downstreamAbortController is defined and abortSignal matches its signal', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, true);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertExists(ctx.downstreamAbortController);
    assertEquals(ctx.abortSignal, ctx.downstreamAbortController.signal);
  });

  test('wantsStream=false: downstreamAbortController and abortSignal are both undefined', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, false);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.downstreamAbortController, undefined);
    assertEquals(ctx.abortSignal, undefined);
  });

  test('scheduleBackground is present and callable without throwing', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, false);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertExists(ctx.scheduleBackground);
    let nothingThrown = true;
    try {
      ctx.scheduleBackground(() => Promise.resolve());
    } catch {
      nothingThrown = false;
    }
    assertEquals(nothingThrown, true);
  });

  test('stamps requestStartedAt from performance.now() at construction', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxFromHono> | undefined;
    const before = performance.now();
    app.get('/test', c => {
      ctx = createGatewayCtxFromHono(c, false);
      return c.text('ok');
    });
    await app.request('/test');
    const after = performance.now();
    assertExists(ctx);
    if (!(ctx.requestStartedAt >= before && ctx.requestStartedAt <= after)) {
      throw new Error(`requestStartedAt ${ctx.requestStartedAt} not in [${before}, ${after}]`);
    }
  });
});

describe('createGatewayCtxForWs', () => {
  test('copies auth fields from Hono context', async () => {
    const app = new Hono<{ Variables: { apiKeyId: string; apiKeyUpstreamIds: readonly string[] } }>();
    let ctx: ReturnType<typeof createGatewayCtxForWs> | undefined;
    app.get('/test', c => {
      c.set('apiKeyId', 'ws-key');
      c.set('apiKeyUpstreamIds', ['ws-up-1']);
      const controller = new AbortController();
      ctx = createGatewayCtxForWs(c, {} as WebSocket, controller);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.apiKeyId, 'ws-key');
    assertEquals(ctx.apiKeyUpstreamIds, ['ws-up-1']);
  });

  test('sets apiKeyId and apiKeyUpstreamIds to null when unset', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxForWs> | undefined;
    app.get('/test', c => {
      const controller = new AbortController();
      ctx = createGatewayCtxForWs(c, {} as WebSocket, controller);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.apiKeyId, null);
    assertEquals(ctx.apiKeyUpstreamIds, null);
  });

  test('forces wantsStream=true', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxForWs> | undefined;
    app.get('/test', c => {
      const controller = new AbortController();
      ctx = createGatewayCtxForWs(c, {} as WebSocket, controller);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertEquals(ctx.wantsStream, true);
  });

  test('sets abortSignal from downstreamAbortController.signal', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxForWs> | undefined;
    let controller: AbortController | undefined;
    app.get('/test', c => {
      controller = new AbortController();
      ctx = createGatewayCtxForWs(c, {} as WebSocket, controller);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertExists(controller);
    assertEquals(ctx.abortSignal, controller.signal);
  });

  test('exposes downstreamAbortController', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxForWs> | undefined;
    let controller: AbortController | undefined;
    app.get('/test', c => {
      controller = new AbortController();
      ctx = createGatewayCtxForWs(c, {} as WebSocket, controller);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertExists(controller);
    assertEquals(ctx.downstreamAbortController, controller);
  });

  test('scheduleBackground is present and callable without throwing', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxForWs> | undefined;
    app.get('/test', c => {
      const controller = new AbortController();
      ctx = createGatewayCtxForWs(c, {} as WebSocket, controller);
      return c.text('ok');
    });
    await app.request('/test');
    assertExists(ctx);
    assertExists(ctx.scheduleBackground);
    let nothingThrown = true;
    try {
      ctx.scheduleBackground(() => Promise.resolve());
    } catch {
      nothingThrown = false;
    }
    assertEquals(nothingThrown, true);
  });

  test('stamps requestStartedAt from performance.now() at construction', async () => {
    const app = new Hono();
    let ctx: ReturnType<typeof createGatewayCtxForWs> | undefined;
    const before = performance.now();
    app.get('/test', c => {
      const controller = new AbortController();
      ctx = createGatewayCtxForWs(c, {} as WebSocket, controller);
      return c.text('ok');
    });
    await app.request('/test');
    const after = performance.now();
    assertExists(ctx);
    if (!(ctx.requestStartedAt >= before && ctx.requestStartedAt <= after)) {
      throw new Error(`requestStartedAt ${ctx.requestStartedAt} not in [${before}, ${after}]`);
    }
  });
});
