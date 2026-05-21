import type { ResponsesPayload } from '../../../../shared/protocol/responses.ts';
import type { ResponsesInterceptor } from '../../../interceptors.ts';

// Opt-in workaround for upstreams where forced `tool_choice` and enabled
// reasoning do not compose. By default this strips OpenAI `reasoning` rather
// than inventing a `none` effort, because upstreams differ on whether `none` is
// accepted. Vendor flags add their documented explicit-disable spellings.
// References:
// - https://api-docs.deepseek.com/guides/thinking_mode
// - https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi
// - https://www.alibabacloud.com/help/en/model-studio/deep-thinking
const hasForcedToolChoice = (payload: ResponsesPayload): boolean => {
  const toolChoice = payload.tool_choice;
  if (toolChoice === undefined || toolChoice === null) return false;
  if (typeof toolChoice === 'string') return toolChoice === 'required';
  return true;
};

const disableResponsesReasoning = (payload: ResponsesPayload, enabledFixes: ReadonlySet<string>): ResponsesPayload => {
  const { reasoning: _reasoning, ...rest } = payload;
  const out: ResponsesPayload & Record<string, unknown> = { ...rest };
  if (enabledFixes.has('vendor-deepseek')) {
    out.thinking = { type: 'disabled' };
  }
  if (enabledFixes.has('vendor-qwen')) {
    out.enable_thinking = false;
  }
  return out;
};

export const withReasoningDisabledOnForcedToolChoice: ResponsesInterceptor = async (ctx, run) => {
  if (!hasForcedToolChoice(ctx.payload)) return await run();
  ctx.payload = disableResponsesReasoning(ctx.payload, ctx.enabledFixes);
  return await run();
};
