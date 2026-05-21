import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { GeminiGenerateContentRequest, GeminiStreamEvent } from '../../../shared/protocol/gemini.ts';
import type { ResponsesPayload } from '../../../shared/protocol/responses.ts';
import type { ResponsesStreamEvent } from '../../shared/protocol/responses.ts';
import type { Translation } from '../types.ts';

export const geminiViaResponsesTranslation: Translation<GeminiGenerateContentRequest, GeminiStreamEvent, ResponsesPayload, ResponsesStreamEvent> = {
  targetApi: 'responses',
  buildTargetPayload: (payload, ctx) => buildTargetRequest(payload, ctx.model, ctx.wantsStream),
  translateEvents: frames => translateToSourceEvents(frames),
};
