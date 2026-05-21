import { responsesStreamFramesToEvents } from './events/from-stream.ts';
import { interceptorsForResponses } from './interceptors/index.ts';
import type { TelemetryModelIdentity } from '../../../../repo/types.ts';
import type { ResponsesPayload, ResponsesResult } from '../../../shared/protocol/responses.ts';
import { runInterceptors } from '../../interceptors.ts';
import { eventResult } from '../../shared/errors/result.ts';
import type { ResponsesStreamEvent } from '../../shared/protocol/responses.ts';
import type { EmitInput, EmitResult } from '../emit-types.ts';
import { targetExchangeMeta, targetInternalError, targetModelIdentity, targetProviderResultToFrames } from '../emit.ts';

export interface EmitToResponsesInput extends EmitInput<ResponsesPayload> {
  targetApi: 'responses';
}

const targetApi = 'responses';

export const emitToResponses = async (input: EmitToResponsesInput): Promise<EmitResult<ResponsesStreamEvent>> => {
  let modelIdentity: TelemetryModelIdentity | undefined;

  try {
    input.payload.stream = true;
    const ctx = { ...targetExchangeMeta(input), payload: input.payload };
    return await runInterceptors(ctx, interceptorsForResponses(input), async () => {
      const upstreamStartedAt = performance.now();
      const { model: _model, ...body } = ctx.payload;
      const providerResult = await input.provider.callResponses(input.upstreamModel, body, ctx.downstreamAbortSignal);
      modelIdentity = targetModelIdentity(input, providerResult.modelKey);
      const telemetryInput = { ...input, payload: ctx.payload };
      const result = await targetProviderResultToFrames<ResponsesResult>(telemetryInput, targetApi, providerResult, modelIdentity, upstreamStartedAt);

      return result.type === 'events' ? eventResult(responsesStreamFramesToEvents(result.events), result.modelIdentity, result.performance, result.finalMetadata) : result;
    });
  } catch (error) {
    return targetInternalError(input, targetApi, error, modelIdentity);
  }
};
