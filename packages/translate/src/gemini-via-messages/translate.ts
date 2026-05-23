import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { GeminiGenerateContentRequest, GeminiStreamEvent } from '@copilot-gateway/protocols/gemini';
import type { MessagesPayload, MessagesStreamEventData } from '@copilot-gateway/protocols/messages';

export const translateGeminiViaMessages: TranslateTrip<
  GeminiGenerateContentRequest, GeminiStreamEvent, MessagesPayload, MessagesStreamEventData,
  { fallbackMaxOutputTokens?: number }
> = async (src, ctx) => ({
  target: buildTargetRequest(src, ctx.model, { fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens }),
  events: translateToSourceEvents,
});
