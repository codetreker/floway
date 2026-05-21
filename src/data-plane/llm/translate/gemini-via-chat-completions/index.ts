import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '../../../shared/protocol/chat-completions.ts';
import type { GeminiGenerateContentRequest, GeminiStreamEvent } from '../../../shared/protocol/gemini.ts';
import type { Translation } from '../types.ts';

export const geminiViaChatCompletionsTranslation: Translation<GeminiGenerateContentRequest, GeminiStreamEvent, ChatCompletionsPayload, ChatCompletionChunk> = {
  targetApi: 'chat-completions',
  buildTargetPayload: (payload, ctx) => buildTargetRequest(payload, ctx.model, ctx.wantsStream),
  translateEvents: frames => translateToSourceEvents(frames),
};
