import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '@copilot-gateway/protocols/chat-completions';
import type { ResponsesPayload, ResponsesStreamEvent } from '@copilot-gateway/protocols/responses';

export const translateChatCompletionsViaResponses: TranslateTrip<
  ChatCompletionsPayload, ChatCompletionChunk, ResponsesPayload, ResponsesStreamEvent
> = async src => ({
  target: buildTargetRequest(src),
  events: translateToSourceEvents,
});
