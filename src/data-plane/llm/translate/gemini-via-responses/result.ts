import type { GeminiFinishReason, GeminiPart, GeminiStreamEvent, GeminiUsageMetadata } from '../../../shared/protocol/gemini.ts';
import type { ResponsesResult, ResponseStreamEvent } from '../../../shared/protocol/responses.ts';

type ResponseTerminalEvent = Extract<ResponseStreamEvent, { type: 'response.completed' } | { type: 'response.incomplete' } | { type: 'response.failed' }>;

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

// Responses input_tokens already includes input_tokens_details.cached_tokens,
// matching Gemini's inclusive promptTokenCount semantics. Pass both through
// directly — no folding. Contrast with gemini-via-messages, where Anthropic's
// input_tokens excludes cache buckets and must be summed.
export const mapUsage = (usage: ResponsesResult['usage']): GeminiUsageMetadata | undefined => {
  if (!usage) return undefined;

  return {
    promptTokenCount: usage.input_tokens,
    candidatesTokenCount: usage.output_tokens,
    totalTokenCount: usage.total_tokens,
    ...(usage.output_tokens_details?.reasoning_tokens !== undefined
      ? {
          thoughtsTokenCount: usage.output_tokens_details.reasoning_tokens,
        }
      : {}),
    ...(usage.input_tokens_details?.cached_tokens !== undefined
      ? {
          cachedContentTokenCount: usage.input_tokens_details.cached_tokens,
        }
      : {}),
  };
};

const isSafetyFailure = (response: ResponsesResult): boolean => {
  const error = response.error;
  if (!error) return false;

  const text = `${error.type} ${error.code} ${error.message}`.toLowerCase();
  return text.includes('safety') || text.includes('content_filter') || text.includes('policy');
};

export const mapTerminalFinishReason = (event: ResponseTerminalEvent): GeminiFinishReason => {
  if (event.type === 'response.completed') return 'STOP';
  if (event.type === 'response.failed') {
    return isSafetyFailure(event.response) ? 'SAFETY' : 'OTHER';
  }

  return event.response.incomplete_details?.reason === 'max_output_tokens' ? 'MAX_TOKENS' : 'OTHER';
};
