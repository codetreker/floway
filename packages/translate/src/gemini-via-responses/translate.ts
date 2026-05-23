import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { GeminiGenerateContentRequest, GeminiStreamEvent } from '@copilot-gateway/protocols/gemini';
import type { ResponsesPayload, ResponsesStreamEvent } from '@copilot-gateway/protocols/responses';

export const translateGeminiViaResponses: TranslateTrip<
  GeminiGenerateContentRequest, GeminiStreamEvent, ResponsesPayload, ResponsesStreamEvent
> = async (src, ctx) => ({
  target: buildTargetRequest(src, ctx.model),
  events: translateToSourceEvents,
});
