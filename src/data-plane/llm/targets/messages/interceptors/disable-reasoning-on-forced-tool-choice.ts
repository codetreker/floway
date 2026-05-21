import type { MessagesPayload } from '../../../../shared/protocol/messages.ts';
import type { MessagesInterceptor } from '../../../interceptors.ts';

// Opt-in workaround for upstreams where forced `tool_choice` and enabled
// thinking do not compose. Messages has a native `thinking: disabled` shape.
const hasForcedToolChoice = (payload: MessagesPayload): boolean => {
  const type = payload.tool_choice?.type;
  return type === 'tool' || type === 'any';
};

const disableMessagesReasoning = (payload: MessagesPayload): MessagesPayload => {
  const { output_config: _outputConfig, ...rest } = payload;
  return { ...rest, thinking: { type: 'disabled' as const } };
};

export const withReasoningDisabledOnForcedToolChoice: MessagesInterceptor = async (ctx, _request, run) => {
  if (!hasForcedToolChoice(ctx.payload)) return await run();
  ctx.payload = disableMessagesReasoning(ctx.payload);
  return await run();
};
