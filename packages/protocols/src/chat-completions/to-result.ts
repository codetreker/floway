import type { ChatCompletionsStreamEvent, ChatCompletionsResult } from './index.ts';
import { reassembleChatCompletionsEvents } from './reassemble.ts';
import { type ProtocolFrame } from '../common/index.ts';

export const CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE = 'Chat Completions stream ended without a DONE sentinel.';

const chatCompletionsEventsUntilDone = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>): AsyncGenerator<ChatCompletionsStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') return;
    yield frame.event;
  }

  throw new Error(CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE);
};

export const collectChatCompletionsProtocolEventsToResult = async (frames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>): Promise<ChatCompletionsResult> => {
  return await reassembleChatCompletionsEvents(chatCompletionsEventsUntilDone(frames));
};
