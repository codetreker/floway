import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '@copilot-gateway/protocols/chat-completions';
import type { MessagesPayload, MessagesStreamEventData } from '@copilot-gateway/protocols/messages';

export const translateChatCompletionsViaMessages: TranslateTrip<
  ChatCompletionsPayload, ChatCompletionChunk, MessagesPayload, MessagesStreamEventData,
  { fallbackMaxOutputTokens?: number }
> = async (src, ctx) => ({
  target: await buildTargetRequest(src, { fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens }),
  events: translateToSourceEvents,
});
