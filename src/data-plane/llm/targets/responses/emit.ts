import { responsesStreamFramesToEvents } from './events/from-stream.ts';
import { interceptorsForResponses } from './interceptors/index.ts';
import type { TelemetryModelIdentity } from '../../../../repo/types.ts';
import type { ResponsesPayload } from '../../../shared/protocol/responses.ts';
import { type RequestContext, type ResponsesInvocation, runInterceptors } from '../../interceptors.ts';
import { eventResult, type ExecuteResult } from '../../shared/errors/result.ts';
import type { ResponsesStreamEvent } from '../../shared/protocol/responses.ts';
import type { ProtocolFrame } from '../../shared/stream/types.ts';
import { targetInternalError, targetModelIdentity, targetProviderResultToFrames } from '../emit.ts';

const targetApi = 'responses';

export const emitToResponses = async (invocation: ResponsesInvocation, request: RequestContext): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
  let modelIdentity: TelemetryModelIdentity | undefined;

  try {
    return await runInterceptors(invocation, request, interceptorsForResponses(invocation), async () => {
      const upstreamStartedAt = performance.now();
      const { model: _model, ...body } = invocation.payload;
      const providerResult = await invocation.provider.callResponses(invocation.upstreamModel, body as Omit<ResponsesPayload, 'model'>, request.downstreamAbortSignal);
      modelIdentity = targetModelIdentity(invocation, providerResult.modelKey);
      const result = await targetProviderResultToFrames(invocation, request, targetApi, providerResult, modelIdentity, upstreamStartedAt);

      return result.type === 'events' ? eventResult(responsesStreamFramesToEvents(result.events), result.modelIdentity, result.performance, result.finalMetadata) : result;
    });
  } catch (error) {
    return targetInternalError(invocation, request, targetApi, error, modelIdentity);
  }
};
