import type { ChatCompletionsInterceptor } from '../../../interceptors.ts';

// Source-side Chat Completions interceptors. None today. Future entries are
// attached to every binding and decide whether to act inside their own body
// (flag-gated entries early-return on `ctx.enabledFlags.has(flagId)`).
export const chatCompletionsSourceInterceptors: readonly ChatCompletionsInterceptor[] = [];
