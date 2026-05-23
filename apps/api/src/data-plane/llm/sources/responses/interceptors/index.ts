import { stripUnsupportedTools } from './strip-unsupported-tools.ts';
import type { ResponsesInterceptor } from '../../../interceptors.ts';

// Source-side Responses interceptors. Every entry is attached to every binding;
// each interceptor's body decides whether to act (flag-gated entries
// early-return on `ctx.enabledFlags.has(flagId)`).
//
//   - stripUnsupportedTools: unconditional protocol-shape cleanup.
export const responsesSourceInterceptors: readonly ResponsesInterceptor[] = [
  stripUnsupportedTools,
];
