import { chatCompletionResultToEvents } from './from-result.ts';
import { chatCompletionsErrorPayloadMessage } from '../../../../shared/protocol/chat-completions-errors.ts';
import type { ChatCompletionChunk, ChatCompletionResponse } from '../../../../shared/protocol/chat-completions.ts';
import { doneFrame, eventFrame, type ProtocolFrame, type StreamFrame } from '../../../shared/stream/types.ts';
import { parseTargetStreamFrames } from '../../events/from-stream.ts';

const chatCompletionsSseJsonToEvent = (parsed: unknown): ChatCompletionChunk => {
  const errorMessage = chatCompletionsErrorPayloadMessage(parsed);
  if (errorMessage) {
    throw new Error(`Upstream Chat Completions SSE error: ${errorMessage}`);
  }

  return parsed as ChatCompletionChunk;
};

export const chatCompletionsStreamFramesToEvents = (frames: AsyncIterable<StreamFrame<ChatCompletionResponse>>): AsyncGenerator<ProtocolFrame<ChatCompletionChunk>> =>
  (async function* () {
    for await (const frame of parseTargetStreamFrames<ChatCompletionResponse>(frames, {
      protocol: 'Chat Completions',
    })) {
      if (frame.type === 'json') {
        yield* chatCompletionResultToEvents(frame.data);
      } else if (frame.type === 'done') {
        yield doneFrame();
      } else {
        yield eventFrame(chatCompletionsSseJsonToEvent(frame.data));
      }
    }
  })();
