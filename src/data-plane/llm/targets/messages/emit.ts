import { messagesStreamFramesToEvents } from './events/from-stream.ts';
import type { TelemetryModelIdentity } from '../../../../repo/types.ts';
import type { MessagesPayload, MessagesResponse, MessagesStreamEventData } from '../../../shared/protocol/messages.ts';
import { runInterceptors } from '../../interceptors.ts';
import { eventResult } from '../../shared/errors/result.ts';
import type { EmitInput, EmitResult } from '../emit-types.ts';
import { targetExchangeMeta, targetInternalError, targetModelIdentity, targetProviderResultToFrames } from '../emit.ts';
import { interceptorsForMessages } from './interceptors/index.ts';

export interface EmitToMessagesInput extends EmitInput<MessagesPayload> {
  targetApi: 'messages';
  anthropicBeta?: readonly string[];
}

const targetApi = 'messages';

export const emitToMessages = async (input: EmitToMessagesInput): Promise<EmitResult<MessagesStreamEventData>> => {
  let modelIdentity: TelemetryModelIdentity | undefined;

  try {
    input.payload.stream = true;
    const ctx = {
      ...targetExchangeMeta(input),
      payload: input.payload,
      ...(input.anthropicBeta !== undefined ? { anthropicBeta: input.anthropicBeta } : {}),
    };
    return await runInterceptors(ctx, interceptorsForMessages(input), async () => {
      const upstreamStartedAt = performance.now();
      const { model: _model, ...body } = ctx.payload;
      const providerResult = await input.provider.callMessages(input.upstreamModel, body, ctx.downstreamAbortSignal, ctx.anthropicBeta);
      modelIdentity = targetModelIdentity(input, providerResult.modelKey);
      const telemetryInput = { ...input, payload: ctx.payload };
      const result = await targetProviderResultToFrames<MessagesResponse>(telemetryInput, targetApi, providerResult, modelIdentity, upstreamStartedAt);

      return result.type === 'events' ? eventResult(messagesStreamFramesToEvents(result.events), result.modelIdentity, result.performance, result.finalMetadata) : result;
    });
  } catch (error) {
    return targetInternalError(input, targetApi, error, modelIdentity);
  }
};
