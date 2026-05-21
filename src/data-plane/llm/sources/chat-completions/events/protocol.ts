import { chatCompletionsErrorPayloadMessage } from '../../../../shared/protocol/chat-completions-errors.ts';
import type { ChatCompletionChunk } from '../../../../shared/protocol/chat-completions.ts';

export const CHAT_COMPLETIONS_MISSING_DONE_MESSAGE = 'Chat Completions stream ended without a DONE sentinel.';

export const isChatCompletionErrorEvent = (event: ChatCompletionChunk) => chatCompletionsErrorPayloadMessage(event) !== null;
