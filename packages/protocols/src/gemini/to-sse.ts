import type { GeminiStreamEvent } from './index.ts';
import { type ProtocolFrame, type SseFrame, sseFrame } from '../common/index.ts';

export const geminiProtocolFrameToSSEFrame = (frame: ProtocolFrame<GeminiStreamEvent>): SseFrame | null => (frame.type === 'done' ? null : sseFrame(JSON.stringify(frame.event)));
