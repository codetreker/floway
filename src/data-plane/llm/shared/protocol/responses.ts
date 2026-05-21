import type { ResponseStreamEvent } from '../../../shared/protocol/responses.ts';

export type ResponsesStreamEvent = ResponseStreamEvent & {
  sequence_number?: number;
};

export const RESPONSES_MISSING_TERMINAL_MESSAGE = 'Responses stream ended without a terminal event.';

export const isResponsesTerminalEvent = (event: Pick<ResponseStreamEvent, 'type'>): boolean =>
  event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed' || event.type === 'error';
