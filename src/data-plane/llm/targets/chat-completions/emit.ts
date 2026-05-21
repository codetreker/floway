import { chatCompletionsStreamFramesToEvents } from './events/from-stream.ts';
import { interceptorsForChatCompletions } from './interceptors/index.ts';
import type { TelemetryModelIdentity } from '../../../../repo/types.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '../../../shared/protocol/chat-completions.ts';
import { type ChatCompletionsInvocation, type RequestContext, runInterceptors } from '../../interceptors.ts';
import { eventResult, type ExecuteResult } from '../../shared/errors/result.ts';
import type { ProtocolFrame } from '../../shared/stream/types.ts';
import { targetInternalError, targetModelIdentity, targetProviderResultToFrames } from '../emit.ts';

const targetApi = 'chat-completions';

export const emitToChatCompletions = async (invocation: ChatCompletionsInvocation, request: RequestContext): Promise<ExecuteResult<ProtocolFrame<ChatCompletionChunk>>> => {
  let modelIdentity: TelemetryModelIdentity | undefined;

  try {
    return await runInterceptors(invocation, request, interceptorsForChatCompletions(invocation), async () => {
      const upstreamStartedAt = performance.now();
      const { model: _model, ...body } = invocation.payload;
      const providerResult = await invocation.provider.callChatCompletions(invocation.upstreamModel, body as Omit<ChatCompletionsPayload, 'model'>, request.downstreamAbortSignal);
      modelIdentity = targetModelIdentity(invocation, providerResult.modelKey);
      const result = await targetProviderResultToFrames(invocation, request, targetApi, providerResult, modelIdentity, upstreamStartedAt);

      return result.type === 'events' ? eventResult(chatCompletionsStreamFramesToEvents(result.events), result.modelIdentity, result.performance, result.finalMetadata) : result;
    });
  } catch (error) {
    return targetInternalError(invocation, request, targetApi, error, modelIdentity);
  }
};
