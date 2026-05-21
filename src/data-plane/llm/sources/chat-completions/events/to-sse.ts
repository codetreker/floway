import type { ChatCompletionChunk } from '../../../../shared/protocol/chat-completions.ts';
import { type ProtocolFrame, type SseFrame, sseFrame } from '../../../shared/stream/types.ts';

interface ChatSseFrameOptions {
  includeUsageChunk: boolean;
}

const isUsageOnlyChunk = (frame: ProtocolFrame<ChatCompletionChunk>): boolean =>
  frame.type === 'event' && Array.isArray(frame.event.choices) && frame.event.choices.length === 0 && frame.event.usage !== undefined;

export const chatProtocolFrameToSSEFrame = (frame: ProtocolFrame<ChatCompletionChunk>, options: ChatSseFrameOptions): SseFrame | null => {
  if (frame.type === 'done') return sseFrame('[DONE]');
  if (!options.includeUsageChunk && isUsageOnlyChunk(frame)) return null;
  return sseFrame(JSON.stringify(frame.event));
};
