import type { Context } from 'hono';

import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';

export interface GatewayCtx {
  readonly apiKeyId: string | null;
  readonly apiKeyUpstreamIds: readonly string[] | null;
  readonly abortSignal?: AbortSignal;
  readonly wantsStream: boolean;
  readonly downstreamAbortController?: AbortController;
  readonly scheduleBackground: (fn: () => Promise<void> | void) => void;
  // Stamped at ctx construction so request-total latency telemetry can subtract
  // from `performance.now()` at response completion.
  readonly requestStartedAt: number;
}

const buildScheduleBackground = (c: Context): GatewayCtx['scheduleBackground'] => {
  const backgroundScheduler = backgroundSchedulerFromContext(c);
  return (fn: () => Promise<void> | void) => backgroundScheduler(Promise.resolve(fn()));
};

export const createGatewayCtxFromHono = (c: Context, wantsStream: boolean): GatewayCtx => {
  const apiKeyId = (c.get('apiKeyId') as string | undefined) ?? null;
  const apiKeyUpstreamIds = (c.get('apiKeyUpstreamIds') as readonly string[] | null | undefined) ?? null;
  const downstreamAbortController = wantsStream ? new AbortController() : undefined;
  return {
    apiKeyId,
    apiKeyUpstreamIds,
    ...(downstreamAbortController !== undefined ? { abortSignal: downstreamAbortController.signal, downstreamAbortController } : {}),
    wantsStream,
    scheduleBackground: buildScheduleBackground(c),
    requestStartedAt: performance.now(),
  };
};

export const createGatewayCtxForWs = (
  c: Context,
  _server: WebSocket,
  downstreamAbortController: AbortController,
): GatewayCtx => {
  const apiKeyId = (c.get('apiKeyId') as string | undefined) ?? null;
  const apiKeyUpstreamIds = (c.get('apiKeyUpstreamIds') as readonly string[] | null | undefined) ?? null;
  return {
    apiKeyId,
    apiKeyUpstreamIds,
    abortSignal: downstreamAbortController.signal,
    wantsStream: true,
    downstreamAbortController,
    scheduleBackground: buildScheduleBackground(c),
    requestStartedAt: performance.now(),
  };
};
