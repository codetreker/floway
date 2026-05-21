import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { MessagesPayload, MessagesStreamEventData } from '../../../shared/protocol/messages.ts';
import type { ResponsesPayload } from '../../../shared/protocol/responses.ts';
import type { ResponsesStreamEvent } from '../../shared/protocol/responses.ts';
import type { Translation } from '../types.ts';

// Synthetic response id generated per Translation invocation so that Responses
// callers can correlate a Messages-backed response. Lives here (Translation
// closure scope) rather than in the source serve, because the lifetime is
// "one Translation invocation" — exactly the scope `viaTranslation` covers.
const createTranslatedResponseId = (): string => `resp_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

export const responsesViaMessagesTranslation: Translation<ResponsesPayload, ResponsesStreamEvent, MessagesPayload, MessagesStreamEventData> = {
  targetApi: 'messages',
  buildTargetPayload: (payload, ctx) => buildTargetRequest(payload, ctx.capabilities),
  translateEvents: (frames, ctx) => translateToSourceEvents(frames, createTranslatedResponseId(), ctx.model),
};
