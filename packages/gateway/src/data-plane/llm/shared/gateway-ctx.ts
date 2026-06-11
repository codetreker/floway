import type { Context } from 'hono';

import { effectiveUpstreamIdsFromContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { runtimeLocationFromRequest } from '../../shared/telemetry/performance.ts';

export interface GatewayCtx {
  readonly apiKeyId: string;
  readonly upstreamIds: readonly string[] | null;
  readonly abortSignal?: AbortSignal;
  readonly wantsStream: boolean;
  readonly downstreamAbortController?: AbortController;
  readonly scheduleBackground: (fn: () => Promise<void> | void) => void;
  // Stamped at ctx construction so request-total latency telemetry can subtract
  // from `performance.now()` at response completion.
  readonly requestStartedAt: number;
  // The deployment colo / region, recorded as the `runtimeLocation` performance
  // dimension. Request-scoped, so it is resolved once here rather than at the
  // provider-call boundary.
  readonly runtimeLocation: string;
}

const buildScheduleBackground = (c: Context): GatewayCtx['scheduleBackground'] => {
  const backgroundScheduler = backgroundSchedulerFromContext(c);
  return (fn: () => Promise<void> | void) => backgroundScheduler(Promise.resolve(fn()));
};

export const createGatewayCtxFromHono = (c: Context, wantsStream: boolean): GatewayCtx => {
  const apiKeyId = c.get('apiKeyId') as string;
  const upstreamIds = effectiveUpstreamIdsFromContext(c);
  const downstreamAbortController = wantsStream ? new AbortController() : undefined;
  return {
    apiKeyId,
    upstreamIds,
    ...(downstreamAbortController !== undefined ? { abortSignal: downstreamAbortController.signal, downstreamAbortController } : {}),
    wantsStream,
    scheduleBackground: buildScheduleBackground(c),
    requestStartedAt: performance.now(),
    runtimeLocation: runtimeLocationFromRequest(c.req.raw),
  };
};

export const createGatewayCtxForWs = (
  c: Context,
  _server: WebSocket,
  downstreamAbortController: AbortController,
): GatewayCtx => {
  const apiKeyId = c.get('apiKeyId') as string;
  const upstreamIds = effectiveUpstreamIdsFromContext(c);
  return {
    apiKeyId,
    upstreamIds,
    abortSignal: downstreamAbortController.signal,
    wantsStream: true,
    downstreamAbortController,
    scheduleBackground: buildScheduleBackground(c),
    requestStartedAt: performance.now(),
    runtimeLocation: runtimeLocationFromRequest(c.req.raw),
  };
};
