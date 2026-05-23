import { getRepo } from '../../../repo/index.ts';
import type { PerformanceApiName, PerformanceDimensions, PerformanceMetricScope } from '../../../repo/types.ts';
import type { BackgroundScheduler } from '../../../runtime/background.ts';
import { getEnv } from '../../../runtime/env.ts';

export interface PerformanceTelemetryContext {
  keyId: string;
  // Public gateway model id. Provider raw selection stays encapsulated; only
  // the provider-owned opaque modelKey crosses this boundary.
  model: string;
  upstream: string | null;
  modelKey: string;
  sourceApi: PerformanceApiName;
  targetApi: PerformanceApiName;
  stream: boolean;
  runtimeLocation: string;
}

const currentHour = (): string => new Date().toISOString().slice(0, 13);

export function runtimeLocationFromRequest(request: Request): string {
  const cf = (request as Request & { cf?: { colo?: unknown } }).cf;
  if (typeof cf?.colo === 'string' && cf.colo) return cf.colo;
  return getEnv('RUNTIME_LOCATION') || 'unknown';
}

const performanceDimensions = (context: PerformanceTelemetryContext, metricScope: PerformanceMetricScope): PerformanceDimensions => ({
  hour: currentHour(),
  metricScope,
  keyId: context.keyId,
  model: context.model,
  upstream: context.upstream,
  modelKey: context.modelKey,
  sourceApi: context.sourceApi,
  targetApi: context.targetApi,
  stream: context.stream,
  runtimeLocation: context.runtimeLocation,
});

export async function recordPerformanceLatency(context: PerformanceTelemetryContext, metricScope: PerformanceMetricScope, durationMs: number): Promise<void> {
  try {
    await getRepo().performance.recordLatency({
      ...performanceDimensions(context, metricScope),
      durationMs,
    });
  } catch (error) {
    console.warn('Failed to record performance latency:', error);
  }
}

export async function recordPerformanceError(context: PerformanceTelemetryContext, metricScope: PerformanceMetricScope): Promise<void> {
  try {
    await getRepo().performance.recordError(performanceDimensions(context, metricScope));
  } catch (error) {
    console.warn('Failed to record performance error:', error);
  }
}

export const recordRequestPerformanceForApiKey = (
  apiKeyId: string | undefined,
  scheduler: BackgroundScheduler | undefined,
  context: PerformanceTelemetryContext | undefined,
  failed: boolean,
  durationMs: number,
): void => {
  if (!apiKeyId || !context) return;
  const keyed = { ...context, keyId: apiKeyId };
  const promise = failed ? recordPerformanceError(keyed, 'request_total') : recordPerformanceLatency(keyed, 'request_total', durationMs);
  scheduler ? scheduler(promise) : void promise;
};
