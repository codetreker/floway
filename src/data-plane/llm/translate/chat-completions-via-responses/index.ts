import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '../../../shared/protocol/chat-completions.ts';
import type { ResponsesPayload } from '../../../shared/protocol/responses.ts';
import type { ResponsesStreamEvent } from '../../shared/protocol/responses.ts';
import type { Translation } from '../types.ts';

export const chatCompletionsViaResponsesTranslation: Translation<ChatCompletionsPayload, ChatCompletionChunk, ResponsesPayload, ResponsesStreamEvent> = {
  targetApi: 'responses',
  buildTargetPayload: payload => buildTargetRequest(payload),
  translateEvents: frames => translateToSourceEvents(frames),
};
