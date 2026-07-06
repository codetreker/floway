import type { CompletionsStreamEvent } from './index.ts';
import { type ProtocolFrame, type SseFrame, sseFrame } from '../common/index.ts';

export const completionsProtocolFrameToSSEFrame = (frame: ProtocolFrame<CompletionsStreamEvent>): SseFrame =>
  (frame.type === 'done' ? sseFrame('[DONE]') : sseFrame(JSON.stringify(frame.event)));
