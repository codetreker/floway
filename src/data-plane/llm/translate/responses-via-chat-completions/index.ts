import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '../../../shared/protocol/chat-completions.ts';
import type { ResponsesPayload } from '../../../shared/protocol/responses.ts';
import type { ResponsesStreamEvent } from '../../shared/protocol/responses.ts';
import type { Translation } from '../types.ts';

export const responsesViaChatCompletionsTranslation: Translation<ResponsesPayload, ResponsesStreamEvent, ChatCompletionsPayload, ChatCompletionChunk> = {
  targetApi: 'chat-completions',
  buildTargetPayload: payload => buildTargetRequest(payload),
  translateEvents: frames => translateToSourceEvents(frames),
};
