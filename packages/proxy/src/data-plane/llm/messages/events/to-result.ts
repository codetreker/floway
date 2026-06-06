import { reassembleMessagesEvents } from './reassemble.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesResult, MessagesStreamEvent } from '@floway-dev/protocols/messages';

export const MESSAGES_MISSING_TERMINAL_MESSAGE = 'Messages stream ended without a message_stop event.';

const messagesEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>): AsyncGenerator<MessagesStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') continue;

    yield frame.event;
    if (frame.event.type === 'message_stop' || frame.event.type === 'error') return;
  }

  throw new Error(MESSAGES_MISSING_TERMINAL_MESSAGE);
};

export const collectMessagesProtocolEventsToResult = async (frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>): Promise<MessagesResult> => {
  return await reassembleMessagesEvents(messagesEventsUntilTerminal(frames));
};
