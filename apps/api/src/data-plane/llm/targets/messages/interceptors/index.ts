import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import type { MessagesInterceptor } from '../../../interceptors.ts';

// Target-side Messages interceptors. Every entry is attached to every binding;
// each interceptor's body decides whether to act (flag-gated entries
// early-return on `ctx.enabledFlags.has(flagId)`).
//
//   - withReasoningDisabledOnForcedToolChoice: gated by
//     `disable-reasoning-on-forced-tool-choice`.
export const messagesBaseInterceptors: readonly MessagesInterceptor[] = [
  withReasoningDisabledOnForcedToolChoice,
];
