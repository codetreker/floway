import type { ResponsesStreamEvent } from '../../../shared/protocol/responses.ts';
import { type ProtocolFrame, type SseFrame, sseFrame } from '../../../shared/stream/types.ts';

export const responsesProtocolFrameToSSEFrame = (frame: ProtocolFrame<ResponsesStreamEvent>): SseFrame | null =>
  frame.type === 'event' ? sseFrame(JSON.stringify(frame.event), frame.event.type) : null;
