import type { MessagesInvocation, RequestContext } from '../../../../llm/interceptors.ts';

/**
 * Copilot's Messages upstream is strict about the `anthropic-beta` header:
 * unknown beta flags cause hard 400s. Our policy mirrors caozhiyuan's
 * buildAnthropicBetaHeader, which combines two transforms:
 *
 *   1. Filter inbound betas against the Copilot allow-list, and additionally
 *      drop `interleaved-thinking-2025-05-14` when the payload requested
 *      adaptive thinking (`thinking.type === 'adaptive'`).
 *   2. After filtering, when the payload requested non-adaptive extended
 *      thinking via `thinking.budget_tokens`, auto-add
 *      `interleaved-thinking-2025-05-14` if it is not already present.
 *
 * The combined behavior means a caller that ships only
 * `context-management-2025-06-27` alongside non-adaptive budget thinking
 * still gets interleaved appended to the wire header. The transform is
 * idempotent on the resulting set.
 *
 * The filtered value is written into the invocation header bag; the source's
 * typed `MessagesInvocation.anthropicBeta` field is the read-only input.
 *
 * Generic in the run-result type because pre-Path A the equivalent filter
 * ran on every Copilot Messages HTTP exchange (chat AND count_tokens).
 * Keeping a single generic interceptor lets both the streaming Messages
 * target chain (`ExecuteResult<...>`) and the count_tokens chain
 * (`Response`) share one definition.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/main/src/services/copilot/create-messages.ts (buildAnthropicBetaHeader)
 */
const ALLOWED_ANTHROPIC_BETAS = new Set([
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'advanced-tool-use-2025-11-20',
]);
const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';

export const withAnthropicBetaHeaderFiltered = async <TResult>(ctx: MessagesInvocation, _request: RequestContext, run: () => Promise<TResult>): Promise<TResult> => {
  const inbound = ctx.anthropicBeta ?? [];
  const isAdaptiveThinking = ctx.payload.thinking?.type === 'adaptive';

  const filtered = inbound
    .filter(value => ALLOWED_ANTHROPIC_BETAS.has(value))
    .filter(value => !(isAdaptiveThinking && value === INTERLEAVED_THINKING_BETA));

  if (ctx.payload.thinking?.budget_tokens && !isAdaptiveThinking && !filtered.includes(INTERLEAVED_THINKING_BETA)) {
    filtered.push(INTERLEAVED_THINKING_BETA);
  }

  const unique = [...new Set(filtered)];
  if (unique.length > 0) {
    ctx.headers['anthropic-beta'] = unique.join(',');
  }

  return await run();
};
