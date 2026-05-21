import type { ChatCompletionsPayload } from '../../../../shared/protocol/chat-completions.ts';
import type { ChatCompletionsInterceptor } from '../../../interceptors.ts';

// Opt-in workaround for upstreams where forced `tool_choice` and enabled
// reasoning do not compose. By default this strips OpenAI `reasoning_effort`
// rather than inventing a `none` effort, because upstreams differ on whether
// `none` is accepted. Vendor flags add their documented explicit-disable
// spellings.
// References:
// - https://api-docs.deepseek.com/guides/thinking_mode
// - https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi
// - https://www.alibabacloud.com/help/en/model-studio/deep-thinking
const hasForcedToolChoice = (payload: ChatCompletionsPayload): boolean => {
  const toolChoice = payload.tool_choice;
  if (toolChoice === undefined || toolChoice === null) return false;
  if (typeof toolChoice === 'string') return toolChoice === 'required';
  return true;
};

const disableChatCompletionsReasoning = (payload: ChatCompletionsPayload, enabledFixes: ReadonlySet<string>): ChatCompletionsPayload => {
  const { reasoning_effort: _reasoningEffort, ...rest } = payload;
  const out: ChatCompletionsPayload & Record<string, unknown> = { ...rest };
  if (enabledFixes.has('vendor-deepseek')) {
    out.thinking = { type: 'disabled' };
  }
  if (enabledFixes.has('vendor-qwen')) {
    out.enable_thinking = false;
  }
  return out;
};

export const withReasoningDisabledOnForcedToolChoice: ChatCompletionsInterceptor = async (ctx, _request, run) => {
  if (!hasForcedToolChoice(ctx.payload)) return await run();
  ctx.payload = disableChatCompletionsReasoning(ctx.payload, ctx.enabledFixes);
  return await run();
};
