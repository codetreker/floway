import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { withCyberPolicyRetried } from './retry-cyber-policy.ts';
import type { ResponsesInterceptor } from '../../../interceptors.ts';

// Target-side Responses interceptors. Every entry is attached to every
// binding; each interceptor's body decides whether to act (flag-gated entries
// early-return on `ctx.enabledFlags.has(flagId)`).
//
//   - withCyberPolicyRetried: gated by `retry-cyber-policy`.
//   - withReasoningDisabledOnForcedToolChoice: gated by
//     `disable-reasoning-on-forced-tool-choice`.
export const responsesBaseInterceptors: readonly ResponsesInterceptor[] = [
  withCyberPolicyRetried,
  withReasoningDisabledOnForcedToolChoice,
];
