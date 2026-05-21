import type { Context } from 'hono';

import type { PerformanceApiName } from '../../../repo/types.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { type PerformanceTelemetryContext, recordRequestPerformanceForApiKey, runtimeLocationFromRequest } from '../../shared/telemetry/performance.ts';
import { recordUsageForApiKey } from '../../shared/telemetry/usage.ts';
import type { RequestContext } from '../interceptors.ts';
import { toInternalDebugError } from '../shared/errors/internal-debug-error.ts';
import { modelLoadErrorResult } from '../shared/errors/model-load-error.ts';
import { internalErrorResult, type ExecuteResult, type UpstreamErrorResult } from '../shared/errors/result.ts';
import { thrownUpstreamErrorResult } from '../shared/errors/upstream-error.ts';
import type { ProtocolFrame } from '../shared/stream/types.ts';

type PerformanceLlmSourceApi = Exclude<PerformanceApiName, 'embeddings'>;

export const createRequestContext = (c: Context, downstreamAbortSignal: AbortSignal | undefined, clientStream: boolean): RequestContext => {
  const apiKeyId = c.get('apiKeyId') as string | undefined;
  const scheduleBackground = backgroundSchedulerFromContext(c);

  return {
    requestStartedAt: performance.now(),
    apiKeyId,
    runtimeLocation: runtimeLocationFromRequest(c.req.raw),
    scheduleBackground,
    recordUsage: recordUsageForApiKey(apiKeyId),
    recordRequestPerformance: recordRequestPerformanceForApiKey(apiKeyId, scheduleBackground),
    clientStream,
    ...(downstreamAbortSignal !== undefined ? { downstreamAbortSignal } : {}),
  };
};

export const jsonUpstreamErrorResult = (status: number, body: unknown, performance?: PerformanceTelemetryContext): UpstreamErrorResult => ({
  type: 'upstream-error',
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(JSON.stringify(body)),
  ...(performance ? { performance } : {}),
});

const openAiModelErrorResult = (status: number, message: string) =>
  jsonUpstreamErrorResult(status, {
    error: { message, type: 'invalid_request_error' },
  });

export const openAiMissingModelResult = (model: string) => openAiModelErrorResult(404, `No upstream provides model ${model}. Configure an upstream that exposes this model in the dashboard.`);

export const openAiUnsupportedEndpointResult = (model: string, endpoint: string) => openAiModelErrorResult(400, `Model ${model} does not support the ${endpoint} endpoint.`);

export const sourceErrorResult = <TEvent>(
  error: unknown,
  options: {
    sourceApi: PerformanceLlmSourceApi;
    internalStatus: number;
    lastPerformance?: PerformanceTelemetryContext;
  },
): ExecuteResult<ProtocolFrame<TEvent>> => {
  try {
    return modelLoadErrorResult(error, options.lastPerformance);
  } catch {
    // modelLoadErrorResult rethrows non-model-load errors; the source boundary
    // still needs to test other request-boundary error shapes before 5xx.
  }

  const upstreamError = thrownUpstreamErrorResult(error, options.lastPerformance);
  if (upstreamError) return upstreamError;

  return internalErrorResult(options.internalStatus, toInternalDebugError(error, options.sourceApi), options.lastPerformance);
};
