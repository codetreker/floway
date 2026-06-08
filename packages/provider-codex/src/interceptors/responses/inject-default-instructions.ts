import type { ResponsesBoundaryCtx } from './types.ts';

// Codex backend rejects /responses requests that lack a non-empty
// `instructions` field with a 4xx ("Instructions are required"). Native
// /v1/responses callers may legitimately omit it, and the
// Messages/ChatCompletions/Gemini translators only synthesize it from a
// caller-supplied system message — so when no system message exists we still
// need a fallback string. We inject a neutral default at the Codex target
// boundary so every request shape (native + every translated source
// protocol) satisfies the upstream contract.
export const injectDefaultInstructions = async <TResult>(
  ctx: ResponsesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const instructions = ctx.payload.instructions;
  if (typeof instructions !== 'string' || instructions.length === 0) {
    ctx.payload = { ...ctx.payload, instructions: "You're a helpful assistant." };
  }
  return await run();
};
