import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '@copilot-gateway/protocols/chat-completions';
import type { GeminiGenerateContentRequest, GeminiStreamEvent } from '@copilot-gateway/protocols/gemini';

export const translateGeminiViaChatCompletions: TranslateTrip<
  GeminiGenerateContentRequest, GeminiStreamEvent, ChatCompletionsPayload, ChatCompletionChunk
> = async (src, ctx) => ({
  target: buildTargetRequest(src, ctx.model),
  events: translateToSourceEvents,
});
