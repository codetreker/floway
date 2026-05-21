import { messagesStreamFramesToEvents } from './events/from-stream.ts';
import { interceptorsForMessages } from './interceptors/index.ts';
import type { TelemetryModelIdentity } from '../../../../repo/types.ts';
import type { MessagesPayload, MessagesStreamEventData } from '../../../shared/protocol/messages.ts';
import { type MessagesInvocation, type RequestContext, runInterceptors } from '../../interceptors.ts';
import { eventResult, type ExecuteResult } from '../../shared/errors/result.ts';
import type { ProtocolFrame } from '../../shared/stream/types.ts';
import { targetInternalError, targetModelIdentity, targetProviderResultToFrames } from '../emit.ts';

const targetApi = 'messages';

export const emitToMessages = async (invocation: MessagesInvocation, request: RequestContext): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEventData>>> => {
  let modelIdentity: TelemetryModelIdentity | undefined;

  try {
    return await runInterceptors(invocation, request, interceptorsForMessages(invocation), async () => {
      const upstreamStartedAt = performance.now();
      const { model: _model, ...body } = invocation.payload;
      const providerResult = await invocation.provider.callMessages(invocation.upstreamModel, body as Omit<MessagesPayload, 'model'>, request.downstreamAbortSignal, invocation.anthropicBeta);
      modelIdentity = targetModelIdentity(invocation, providerResult.modelKey);
      const result = await targetProviderResultToFrames(invocation, request, targetApi, providerResult, modelIdentity, upstreamStartedAt);

      return result.type === 'events' ? eventResult(messagesStreamFramesToEvents(result.events), result.modelIdentity, result.performance, result.finalMetadata) : result;
    });
  } catch (error) {
    return targetInternalError(invocation, request, targetApi, error, modelIdentity);
  }
};
