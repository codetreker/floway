import type { GeminiInterceptor } from '../../../interceptors.ts';

/**
 * Gemini safety controls are source-specific and have no matching control on
 * every target path. Drop them so we don't pretend to enforce a policy we
 * cannot honor end-to-end.
 */
export const stripSafetySettings: GeminiInterceptor = (ctx, _request, run) => {
  delete ctx.payload.safetySettings;
  return run();
};
