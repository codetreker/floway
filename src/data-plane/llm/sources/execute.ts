import type { Context } from 'hono';

import type { PerformanceApiName } from '../../../repo/types.ts';
import { type BackgroundScheduler, backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import type { ProviderModelRecord } from '../../providers/types.ts';
import { type PerformanceTelemetryContext, type RecordRequestPerformance, recordRequestPerformanceForApiKey, runtimeLocationFromRequest } from '../../shared/telemetry/performance.ts';
import { type RecordUsage, recordUsageForApiKey } from '../../shared/telemetry/usage.ts';
import type { LlmExchangeMeta, LlmSourceApi, LlmTargetApi } from '../interceptors.ts';
import { toInternalDebugError } from '../shared/errors/internal-debug-error.ts';
import { modelLoadErrorResult } from '../shared/errors/model-load-error.ts';
import { internalErrorResult, type StreamExecuteResult, type UpstreamErrorResult } from '../shared/errors/result.ts';
import { thrownUpstreamErrorResult } from '../shared/errors/upstream-error.ts';
import type { EmitInput } from '../targets/emit-types.ts';

interface PerformanceBearingResult {
  performance?: PerformanceTelemetryContext;
}

type PerformanceLlmSourceApi = Exclude<PerformanceApiName, 'embeddings'>;

export interface SourceExecutionContext {
  requestStartedAt: number;
  apiKeyId?: string;
  runtimeLocation: string;
  scheduleBackground?: BackgroundScheduler;
  recordUsage: RecordUsage;
  recordRequestPerformance: RecordRequestPerformance;
  readonly lastPerformance?: PerformanceTelemetryContext;
  readonly downstreamAbortController?: AbortController;
  readonly downstreamAbortSignal?: AbortSignal;
  beginDownstream(wantsStream: boolean): void;
  rememberPerformance<T extends PerformanceBearingResult>(result: T): T;
}

export const sourceExchangeMeta = (source: SourceExecutionContext, binding: ProviderModelRecord, sourceApi: LlmSourceApi, targetApi: LlmTargetApi, model: string): LlmExchangeMeta => ({
  sourceApi,
  targetApi,
  model,
  upstream: binding.upstream,
  provider: binding.provider,
  upstreamModel: binding.upstreamModel,
  enabledFixes: binding.enabledFixes,
  apiKeyId: source.apiKeyId,
  downstreamAbortSignal: source.downstreamAbortSignal,
});

export const sourceTargetInput = <TPayload extends { model: string }, TTargetApi extends LlmTargetApi, TExtra extends object = Record<never, never>>(
  source: SourceExecutionContext,
  binding: ProviderModelRecord,
  sourceApi: LlmSourceApi,
  targetApi: TTargetApi,
  model: string,
  payload: TPayload,
  clientStream: boolean,
  extra?: TExtra,
): EmitInput<TPayload> & { targetApi: TTargetApi } & TExtra => ({
  ...sourceExchangeMeta(source, binding, sourceApi, targetApi, model),
  targetApi,
  payload,
  targetInterceptors: binding.targetInterceptors,
  clientStream,
  runtimeLocation: source.runtimeLocation,
  scheduleBackground: source.scheduleBackground,
  ...(extra ?? ({} as TExtra)),
});

export const createSourceExecutionContext = (c: Context): SourceExecutionContext => {
  const apiKeyId = c.get('apiKeyId') as string | undefined;
  const scheduleBackground = backgroundSchedulerFromContext(c);
  let lastPerformance: PerformanceTelemetryContext | undefined;
  let downstreamAbortController: AbortController | undefined;

  return {
    requestStartedAt: performance.now(),
    apiKeyId,
    runtimeLocation: runtimeLocationFromRequest(c.req.raw),
    scheduleBackground,
    recordUsage: recordUsageForApiKey(apiKeyId),
    recordRequestPerformance: recordRequestPerformanceForApiKey(apiKeyId, scheduleBackground),
    get lastPerformance() {
      return lastPerformance;
    },
    get downstreamAbortController() {
      return downstreamAbortController;
    },
    get downstreamAbortSignal() {
      return downstreamAbortController?.signal;
    },
    beginDownstream(wantsStream) {
      downstreamAbortController = wantsStream ? new AbortController() : undefined;
    },
    rememberPerformance(result) {
      if (result.performance) lastPerformance = result.performance;
      return result;
    },
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
): StreamExecuteResult<TEvent> => {
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
