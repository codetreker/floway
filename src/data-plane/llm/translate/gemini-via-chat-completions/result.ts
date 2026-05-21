import type { ChatCompletionChunk } from '../../../shared/protocol/chat-completions.ts';
import type { GeminiFinishReason, GeminiUsageMetadata } from '../../../shared/protocol/gemini.ts';

type ChatStreamChoice = ChatCompletionChunk['choices'][0];

export const mapFinishReason = (finishReason: ChatStreamChoice['finish_reason']): GeminiFinishReason | undefined => {
  switch (finishReason) {
  case 'stop':
  case 'tool_calls':
    return 'STOP';
  case 'length':
    return 'MAX_TOKENS';
  case 'content_filter':
    return 'SAFETY';
  default:
    return undefined;
  }
};

const reasoningTokensFromUsage = (usage: NonNullable<ChatCompletionChunk['usage']>): number | undefined => {
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;

  return typeof reasoningTokens === 'number' ? reasoningTokens : undefined;
};

// OpenAI prompt_tokens already includes prompt_tokens_details.cached_tokens,
// matching Gemini's inclusive promptTokenCount semantics. Pass both through
// directly — no folding. Contrast with gemini-via-messages, where Anthropic's
// input_tokens excludes cache buckets and must be summed.
export const mapUsage = (usage?: ChatCompletionChunk['usage']): GeminiUsageMetadata | undefined => {
  if (!usage) return undefined;

  const metadata: GeminiUsageMetadata = {
    promptTokenCount: usage.prompt_tokens,
    candidatesTokenCount: usage.completion_tokens,
    totalTokenCount: usage.total_tokens,
  };

  const thoughtsTokenCount = reasoningTokensFromUsage(usage);
  if (thoughtsTokenCount !== undefined) {
    metadata.thoughtsTokenCount = thoughtsTokenCount;
  }

  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
  if (cachedTokens !== undefined) {
    metadata.cachedContentTokenCount = cachedTokens;
  }

  return metadata;
};
