import { stripSafetySettings } from './strip-safety-settings.ts';
import { stripUnsupportedPartFields } from './strip-unsupported-part-fields.ts';
import { stripUnsupportedTools } from './strip-unsupported-tools.ts';
import { suppressThoughtParts } from './suppress-thought-parts.ts';
import type { GeminiInterceptor } from '../../../interceptors.ts';

// Source-side Gemini interceptors. Every entry is attached to every binding;
// each interceptor's body decides whether to act (flag-gated entries
// early-return on `ctx.enabledFlags.has(flagId)`).
//
// All four entries below are unconditional protocol-shape cleanups required
// because Gemini-shape requests cannot ride verbatim through other targets.
export const geminiSourceInterceptors: readonly GeminiInterceptor[] = [
  stripUnsupportedPartFields,
  stripUnsupportedTools,
  stripSafetySettings,
  suppressThoughtParts,
];
