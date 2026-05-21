import { isMessagesTerminalEvent, MESSAGES_MISSING_TERMINAL_MESSAGE } from './protocol.ts';
import { reassembleMessagesEvents } from './reassemble.ts';
import type { MessagesResponse, MessagesStreamEventData } from '../../../../shared/protocol/messages.ts';
import type { ProtocolFrame } from '../../../shared/stream/types.ts';

const messagesEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>): AsyncGenerator<MessagesStreamEventData> {
  for await (const frame of frames) {
    if (frame.type === 'done') continue;

    yield frame.event;
    if (isMessagesTerminalEvent(frame.event)) return;
  }

  throw new Error(MESSAGES_MISSING_TERMINAL_MESSAGE);
};

export const collectMessagesProtocolEventsToResponse = async (frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>): Promise<MessagesResponse> => {
  return await reassembleMessagesEvents(messagesEventsUntilTerminal(frames));
};
