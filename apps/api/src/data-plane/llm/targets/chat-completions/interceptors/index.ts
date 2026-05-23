import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { withUsageStreamOptionsIncluded } from './include-usage-stream-options.ts';
import { withDeepseekReasoningDialect } from './normalize-reasoning-dialect.ts';
import { withUsageNormalized } from './normalize-usage.ts';
import type { ChatCompletionsInterceptor } from '../../../interceptors.ts';

// Target-side Chat Completions interceptors. Every entry is attached to every
// binding; each interceptor's body decides whether to act (flag-gated entries
// early-return on `ctx.enabledFlags.has(flagId)`).
//
//   - withUsageStreamOptionsIncluded, withUsageNormalized: unconditional.
//     Both gate the gateway's usage-tracking pipeline. Turning either off
//     would silently break per-key telemetry, so neither is surfaced as a flag.
//   - withDeepseekReasoningDialect: gated by `deepseek-reasoning-dialect`.
//   - withReasoningDisabledOnForcedToolChoice: gated by
//     `disable-reasoning-on-forced-tool-choice`.
export const chatCompletionsBaseInterceptors: readonly ChatCompletionsInterceptor[] = [
  withUsageStreamOptionsIncluded,
  withUsageNormalized,
  withDeepseekReasoningDialect,
  withReasoningDisabledOnForcedToolChoice,
];
