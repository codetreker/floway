import { type ProtocolFrame, type SseFrame, sseFrame } from '@copilot-gateway/protocols/common';
import type { ResponsesStreamEvent } from '@copilot-gateway/protocols/responses';

export const responsesProtocolFrameToSSEFrame = (frame: ProtocolFrame<ResponsesStreamEvent>): SseFrame | null =>
  frame.type === 'event' ? sseFrame(JSON.stringify(frame.event), frame.event.type) : null;
