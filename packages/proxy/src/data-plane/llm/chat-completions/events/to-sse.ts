import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { type ProtocolFrame, type SseFrame, sseFrame } from '@floway-dev/protocols/common';

interface ChatCompletionsSseFrameOptions {
  includeUsageChunk: boolean;
}

export const chatCompletionsProtocolFrameToSSEFrame = (frame: ProtocolFrame<ChatCompletionsStreamEvent>, options: ChatCompletionsSseFrameOptions): SseFrame | null => {
  if (frame.type === 'done') return sseFrame('[DONE]');
  if (!options.includeUsageChunk && frame.type === 'event' && Array.isArray(frame.event.choices) && frame.event.choices.length === 0 && frame.event.usage !== undefined) return null;
  return sseFrame(JSON.stringify(frame.event));
};
