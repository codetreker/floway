import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { GeminiGenerateContentRequest, GeminiStreamEvent } from '../../../shared/protocol/gemini.ts';
import type { MessagesPayload, MessagesStreamEventData } from '../../../shared/protocol/messages.ts';
import type { Translation } from '../types.ts';

export const geminiViaMessagesTranslation: Translation<GeminiGenerateContentRequest, GeminiStreamEvent, MessagesPayload, MessagesStreamEventData> = {
  targetApi: 'messages',
  buildTargetPayload: (payload, ctx) => buildTargetRequest(payload, ctx.model, ctx.wantsStream, ctx.capabilities),
  translateEvents: frames => translateToSourceEvents(frames),
};
