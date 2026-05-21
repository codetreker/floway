import type { GeminiStreamEvent } from '../../../../shared/protocol/gemini.ts';
import { type ProtocolFrame, type SseFrame, sseFrame } from '../../../shared/stream/types.ts';

export const geminiProtocolFrameToSSEFrame = (frame: ProtocolFrame<GeminiStreamEvent>): SseFrame | null => (frame.type === 'done' ? null : sseFrame(JSON.stringify(frame.event)));
