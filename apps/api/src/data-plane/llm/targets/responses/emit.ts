import { type RequestContext, type ResponsesInvocation, runInterceptors } from '../../interceptors.ts';
import { targetInternalError, targetModelIdentity, targetStreamResultToExecuteResult, targetUpstreamErrorResult } from '../emit.ts';
import { recordUpstreamLatency, targetPerformanceContext } from '../telemetry.ts';
import { responsesBaseInterceptors } from './interceptors/index.ts';
import { doneFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { responsesResultToEvents, type ResponsesPayload, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type TelemetryModelIdentity, type ExecuteResult, eventResult } from '@floway-dev/provider';

const targetApi = 'responses';

export const emitToResponses = async (invocation: ResponsesInvocation, request: RequestContext): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
  let modelIdentity: TelemetryModelIdentity | undefined;

  try {
    return await runInterceptors(invocation, request, [...responsesBaseInterceptors, ...(invocation.targetInterceptors?.responses ?? [])], async () => {
      const upstreamStartedAt = performance.now();
      const { model: _model, ...body }: ResponsesPayload = invocation.payload;
      const providerResult = await invocation.provider.callResponses(invocation.upstreamModel, body, request.downstreamAbortSignal, invocation.headers);
      modelIdentity = targetModelIdentity(invocation, providerResult.modelKey);
      return await targetStreamResultToExecuteResult(invocation, request, targetApi, providerResult, modelIdentity, upstreamStartedAt);
    });
  } catch (error) {
    return targetInternalError(invocation, request, targetApi, error, modelIdentity);
  }
};

// `/responses/compact` is non-streaming: the provider yields the compaction
// envelope as a value, so we build the canonical event frames here — generic
// item expansion keeps the input-shaped retained messages intact — instead of
// pretending the result came from an SSE body. Runs the same interceptor
// stack as generation. `stream` is dropped before reaching the provider so
// the upstream request stays non-streaming.
export const emitToResponsesCompact = async (invocation: ResponsesInvocation, request: RequestContext): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
  let modelIdentity: TelemetryModelIdentity | undefined;

  try {
    return await runInterceptors(invocation, request, [...responsesBaseInterceptors, ...(invocation.targetInterceptors?.responses ?? [])], async () => {
      const upstreamStartedAt = performance.now();
      const { model: _model, stream: _stream, ...body } = invocation.payload;
      const providerResult = await invocation.provider.callResponsesCompact(invocation.upstreamModel, body, request.downstreamAbortSignal, invocation.headers);
      modelIdentity = targetModelIdentity(invocation, providerResult.modelKey);
      if (!providerResult.ok) return await targetUpstreamErrorResult(providerResult.response, invocation, request, targetApi, modelIdentity);

      recordUpstreamLatency(invocation, request, targetApi, modelIdentity, performance.now() - upstreamStartedAt);
      return eventResult(compactionFrames(providerResult.result), modelIdentity, targetPerformanceContext(invocation, request, targetApi, modelIdentity));
    });
  } catch (error) {
    return targetInternalError(invocation, request, targetApi, error, modelIdentity);
  }
};

const compactionFrames = async function* (result: ResponsesResult): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  yield* responsesResultToEvents(result, { genericOutputItems: true });
  yield doneFrame();
};
