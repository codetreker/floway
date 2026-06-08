import { reassembleResponsesEvents } from './reassemble.ts';
import { type ProtocolFrame } from '@floway-dev/protocols/common';
import { isResponsesTerminalEvent, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';

export const RESPONSES_MISSING_TERMINAL_MESSAGE = 'Responses stream ended without a terminal event.';

export const collectResponsesProtocolEventsToResult = async (frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>): Promise<ResponsesResult> => {
  const events = async function* (): AsyncGenerator<ResponsesStreamEvent> {
    for await (const frame of frames) {
      if (frame.type === 'done') continue;

      yield frame.event;
      if (isResponsesTerminalEvent(frame.event)) return;
    }

    throw new Error(RESPONSES_MISSING_TERMINAL_MESSAGE);
  };

  return await reassembleResponsesEvents(events());
};
