import { type ProtocolFrame, type SseFrame, sseFrame } from '@copilot-gateway/protocols/common';
import type { GeminiStreamEvent } from '@copilot-gateway/protocols/gemini';

export const geminiProtocolFrameToSSEFrame = (frame: ProtocolFrame<GeminiStreamEvent>): SseFrame | null => (frame.type === 'done' ? null : sseFrame(JSON.stringify(frame.event)));
