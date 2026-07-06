import { billableServiceTier, tokenUsage } from '../../shared/telemetry/usage.ts';
import type { ResponsesResult } from '@floway-dev/protocols/responses';

// OpenAI Responses reports input_tokens inclusive of cached tokens; subtract
// the cached split to recover the disjoint bare input. The top-level
// `service_tier` echoes the actual processing tier the upstream served the
// request at (e.g. `default` when capacity downgraded a `priority` request).
// We surface it via `billableServiceTier` so per-tier pricing overrides
// resolve at recording time.
// https://developers.openai.com/api/docs/guides/priority-processing
export const tokenUsageFromResponsesResult = (response: ResponsesResult) => {
  const usage = response.usage;
  if (!usage) return null;
  const cacheRead = usage.input_tokens_details?.cached_tokens ?? 0;
  return tokenUsage({
    input: usage.input_tokens - cacheRead,
    input_cache_read: cacheRead,
    output: usage.output_tokens,
    tier: billableServiceTier(response.service_tier),
  });
};
