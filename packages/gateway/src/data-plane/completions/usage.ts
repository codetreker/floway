import type { TokenUsage } from '../../repo/types.ts';
import { billableServiceTier, openAICacheTokensFromUsage, tokenUsage } from '../shared/telemetry/usage.ts';

// `/v1/completions` shares OpenAI's CompletionUsage schema with
// `/v1/chat/completions`. Both routes hand off to the shared
// `openAICacheTokensFromUsage` helper for the cache-read / cache-write
// counts so the variant field names wild OpenAI-compatible upstreams
// emit (DeepSeek's `prompt_cache_hit_tokens`, Moonshot's flat
// `cached_tokens`, OpenRouter's `cache_write_tokens`, …) land in the
// correct dimensions automatically. The bare `input` dimension subtracts
// both cache counts so the three input dimensions stay disjoint.
//
// `service_tier` lives on the response root, not inside `usage`, and is
// supplied separately by the caller. vLLM surfaces it on the
// non-streaming /v1/completions body (observed null on a Zhipu/GLM
// fork); the streaming path was observed to omit the field.

export const tokenUsageFromCompletionsUsage = (usage: unknown, serviceTier: string | null | undefined): TokenUsage | null => {
  if (!usage || typeof usage !== 'object') return null;
  const { prompt_tokens: promptTokens, completion_tokens: completionTokens } = usage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
  if (typeof promptTokens !== 'number' || typeof completionTokens !== 'number') return null;
  const { cacheRead, cacheWrite } = openAICacheTokensFromUsage(usage);
  return tokenUsage({
    input: promptTokens - cacheRead - cacheWrite,
    input_cache_read: cacheRead,
    input_cache_write: cacheWrite,
    output: completionTokens,
    tier: billableServiceTier(serviceTier),
  });
};
