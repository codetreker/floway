import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '../../../shared/protocol/chat-completions.ts';
import type { MessagesPayload, MessagesStreamEventData } from '../../../shared/protocol/messages.ts';
import type { Translation } from '../types.ts';

export const chatCompletionsViaMessagesTranslation: Translation<ChatCompletionsPayload, ChatCompletionChunk, MessagesPayload, MessagesStreamEventData> = {
  targetApi: 'messages',
  buildTargetPayload: (payload, ctx) => buildTargetRequest(payload, ctx.capabilities),
  translateEvents: frames => translateToSourceEvents(frames),
};
