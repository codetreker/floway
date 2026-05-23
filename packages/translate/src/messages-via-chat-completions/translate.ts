import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '@copilot-gateway/protocols/chat-completions';
import type { MessagesPayload, MessagesStreamEventData } from '@copilot-gateway/protocols/messages';

export const translateMessagesViaChatCompletions: TranslateTrip<
  MessagesPayload, MessagesStreamEventData, ChatCompletionsPayload, ChatCompletionChunk
> = async src => ({
  target: buildTargetRequest(src),
  events: translateToSourceEvents,
});
