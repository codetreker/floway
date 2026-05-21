import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '../../../shared/protocol/chat-completions.ts';
import type { MessagesPayload, MessagesStreamEventData } from '../../../shared/protocol/messages.ts';
import type { Translation } from '../types.ts';

export const messagesViaChatCompletionsTranslation: Translation<MessagesPayload, MessagesStreamEventData, ChatCompletionsPayload, ChatCompletionChunk> = {
  targetApi: 'chat-completions',
  buildTargetPayload: payload => buildTargetRequest(payload),
  translateEvents: frames => translateToSourceEvents(frames),
};
