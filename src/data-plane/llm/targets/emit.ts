import type { EmitInput, RawEmitResult } from './emit-types.ts';
import { recordUpstreamHttpFailure, targetPerformanceContext, withUpstreamTelemetry } from './telemetry.ts';
import type { PerformanceApiName, TelemetryModelIdentity } from '../../../repo/types.ts';
import type { ProviderCallResult } from '../../providers/types.ts';
import type { LlmExchangeMeta } from '../interceptors.ts';
import { toInternalDebugError } from '../shared/errors/internal-debug-error.ts';
import { eventResult, type InternalErrorResult, internalErrorResult } from '../shared/errors/result.ts';
import { readUpstreamError } from '../shared/errors/upstream-error.ts';
import { parseSSEStream } from '../shared/stream/parse-sse.ts';
import { jsonFrame, type StreamFrame } from '../shared/stream/types.ts';

export type TargetEmitPayload = {
  model: string;
  stream?: boolean | null;
};

export type TargetEmitApiName = Exclude<PerformanceApiName, 'gemini' | 'embeddings'>;

const isSSEResponse = (response: Response): boolean => (response.headers.get('content-type') ?? '').includes('text/event-stream');

export const targetModelIdentity = (input: EmitInput<TargetEmitPayload>, modelKey: string): TelemetryModelIdentity => ({
  model: input.model,
  upstream: input.upstream,
  modelKey,
});

export const targetExchangeMeta = (input: EmitInput<TargetEmitPayload>): LlmExchangeMeta => ({
  sourceApi: input.sourceApi,
  targetApi: input.targetApi,
  model: input.model,
  upstream: input.upstream,
  upstreamModel: input.upstreamModel,
  provider: input.provider,
  enabledFixes: input.enabledFixes,
  ...(input.apiKeyId !== undefined ? { apiKeyId: input.apiKeyId } : {}),
  ...(input.downstreamAbortSignal !== undefined ? { downstreamAbortSignal: input.downstreamAbortSignal } : {}),
});

const upstreamFrames = <TJson>(response: Response, signal: AbortSignal | undefined): AsyncIterable<StreamFrame<TJson>> => {
  if (isSSEResponse(response)) {
    return parseSSEStream(response.body!, { signal });
  }

  return (async function* () {
    yield jsonFrame((await response.json()) as TJson);
  })();
};

export const targetProviderResultToFrames = async <TJson>(
  input: EmitInput<TargetEmitPayload>,
  targetApi: TargetEmitApiName,
  providerResult: ProviderCallResult,
  modelIdentity: TelemetryModelIdentity,
  upstreamStartedAt: number,
): Promise<RawEmitResult<TJson>> => {
  const perfContext = targetPerformanceContext(input, targetApi, modelIdentity);
  const { response } = providerResult;

  if (!response.ok) {
    recordUpstreamHttpFailure(input, targetApi, modelIdentity);
    return {
      ...(await readUpstreamError(response)),
      performance: perfContext,
    };
  }

  if (!response.body) {
    return internalErrorResult(502, toInternalDebugError(new Error('No response body from upstream'), input.sourceApi, targetApi), perfContext);
  }

  return eventResult(withUpstreamTelemetry(upstreamFrames<TJson>(response, input.downstreamAbortSignal), input, targetApi, upstreamStartedAt, modelIdentity), modelIdentity, perfContext);
};

export const targetInternalError = (input: EmitInput<TargetEmitPayload>, targetApi: TargetEmitApiName, error: unknown, modelIdentity: TelemetryModelIdentity | undefined): InternalErrorResult =>
  internalErrorResult(502, toInternalDebugError(error, input.sourceApi, targetApi), modelIdentity ? targetPerformanceContext(input, targetApi, modelIdentity) : undefined);
