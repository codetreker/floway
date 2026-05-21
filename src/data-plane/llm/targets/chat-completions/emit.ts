import { chatCompletionsStreamFramesToEvents } from './events/from-stream.ts';
import type { TelemetryModelIdentity } from '../../../../repo/types.ts';
import type { ChatCompletionChunk, ChatCompletionResponse, ChatCompletionsPayload } from '../../../shared/protocol/chat-completions.ts';
import { runInterceptors } from '../../interceptors.ts';
import { eventResult } from '../../shared/errors/result.ts';
import type { EmitInput, EmitResult } from '../emit-types.ts';
import { targetExchangeMeta, targetInternalError, targetModelIdentity, targetProviderResultToFrames } from '../emit.ts';
import { interceptorsForChatCompletions } from './interceptors/index.ts';

export interface EmitToChatCompletionsInput extends EmitInput<ChatCompletionsPayload> {
  targetApi: 'chat-completions';
}

const targetApi = 'chat-completions';

export const emitToChatCompletions = async (input: EmitToChatCompletionsInput): Promise<EmitResult<ChatCompletionChunk>> => {
  let modelIdentity: TelemetryModelIdentity | undefined;
  const ctx = { ...targetExchangeMeta(input), payload: input.payload };

  try {
    return await runInterceptors(ctx, interceptorsForChatCompletions(input), async () => {
      const upstreamStartedAt = performance.now();
      const { model: _model, ...body } = ctx.payload;
      const providerResult = await input.provider.callChatCompletions(input.upstreamModel, body, ctx.downstreamAbortSignal);
      modelIdentity = targetModelIdentity(input, providerResult.modelKey);
      const telemetryInput = { ...input, payload: ctx.payload };
      const result = await targetProviderResultToFrames<ChatCompletionResponse>(telemetryInput, targetApi, providerResult, modelIdentity, upstreamStartedAt);

      return result.type === 'events' ? eventResult(chatCompletionsStreamFramesToEvents(result.events), result.modelIdentity, result.performance, result.finalMetadata) : result;
    });
  } catch (error) {
    return targetInternalError(input, targetApi, error, modelIdentity);
  }
};
