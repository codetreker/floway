import type { ResponseInputItem } from '@floway-dev/protocols/responses';
import type { ResponsesInterceptor } from '../../../../llm/interceptors.ts';

/**
 * Copilot's `x-initiator` header distinguishes user-triggered turns from
 * agent-triggered tool-result consumption. On Responses the discriminator is
 * the last input item: a trailing `function_call_output` means the agent is
 * feeding a tool result back to the model, so initiator = agent. Anything
 * else (user/system/developer message, plain string input) means the user
 * just spoke, so initiator = user.
 *
 * The header name is lowercase `x-initiator`; HTTP header names are
 * case-insensitive on the wire, so the casing is cosmetic.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/main/src/routes/responses/utils.ts#L60-L73
 *   (`hasAgentInitiator`)
 */
const isAgentInitiated = (lastItem: ResponseInputItem | undefined): boolean => lastItem?.type === 'function_call_output';

export const withInitiatorHeaderSet: ResponsesInterceptor = async (ctx, _request, run) => {
  const input = ctx.payload.input;
  const initiator: 'user' | 'agent' = Array.isArray(input) && isAgentInitiated(input.at(-1)) ? 'agent' : 'user';
  ctx.headers['x-initiator'] = initiator;

  return await run();
};
