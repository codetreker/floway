import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { MessagesPayload, MessagesStreamEventData } from '@copilot-gateway/protocols/messages';
import type { ResponsesPayload, ResponsesStreamEvent } from '@copilot-gateway/protocols/responses';

export const translateMessagesViaResponses: TranslateTrip<
  MessagesPayload, MessagesStreamEventData, ResponsesPayload, ResponsesStreamEvent
> = async src => ({
  target: buildTargetRequest(src),
  events: translateToSourceEvents,
});
