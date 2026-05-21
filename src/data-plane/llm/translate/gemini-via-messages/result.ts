import type { GeminiFinishReason, GeminiPart, GeminiStreamEvent, GeminiUsageMetadata } from '../../../shared/protocol/gemini.ts';
import type { MessagesStreamEventData } from '../../../shared/protocol/messages.ts';

export const geminiResponse = (parts: GeminiPart[], finishReason?: GeminiFinishReason, usageMetadata?: GeminiUsageMetadata): GeminiStreamEvent => ({
  candidates: [
    {
      index: 0,
      content: { role: 'model', parts },
      ...(finishReason !== undefined ? { finishReason } : {}),
    },
  ],
  ...(usageMetadata !== undefined ? { usageMetadata } : {}),
});

export const messagesStopReasonToGemini = (stopReason: Extract<MessagesStreamEventData, { type: 'message_delta' }>['delta']['stop_reason']): GeminiFinishReason => {
  switch (stopReason) {
  case 'end_turn':
  case 'tool_use':
  case 'stop_sequence':
    return 'STOP';
  case 'max_tokens':
    return 'MAX_TOKENS';
  case 'refusal':
    return 'SAFETY';
  default:
    return 'OTHER';
  }
};
