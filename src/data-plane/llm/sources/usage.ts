import type * as C from '../../shared/protocol/chat-completions.ts';
import type * as G from '../../shared/protocol/gemini.ts';
import type * as M from '../../shared/protocol/messages.ts';
import type * as R from '../../shared/protocol/responses.ts';
import { tokenUsage } from '../../shared/telemetry/usage.ts';
import type { ProtocolFrame } from '../shared/stream/types.ts';

type CC = C.ChatCompletionChunk;
type CU = NonNullable<C.ChatCompletionResponse['usage']>;
type GE = G.GeminiStreamEvent;
type GR = G.GeminiGenerateContentResponse;
type MU = M.MessagesUsage | NonNullable<M.MessagesMessageDeltaEvent['usage']>;
type RE = R.ResponseStreamEvent;
type RR = R.ResponsesResult;

export const tokenUsageFromMessagesUsage = (u: MU) => {
  const read = u.cache_read_input_tokens ?? 0;
  const created = u.cache_creation_input_tokens ?? 0;
  return tokenUsage((u.input_tokens ?? 0) + read + created, u.output_tokens, read, created);
};
export const createMessagesStreamUsageState = () => ({
  current: tokenUsage(),
  gotInputFromStart: false,
});

type MessagesStreamUsageState = ReturnType<typeof createMessagesStreamUsageState>;
const mergeMessagesUsage = (state: MessagesStreamUsageState, u: MU) => Object.assign(state.current, tokenUsageFromMessagesUsage(u));

export const tokenUsageFromMessagesFrame = (frame: ProtocolFrame<M.MessagesStreamEventData>, state: MessagesStreamUsageState) => {
  if (frame.type !== 'event') return null;
  const { event } = frame;
  if (event.type === 'message_start') {
    const usage = mergeMessagesUsage(state, event.message.usage);
    state.gotInputFromStart ||= usage.inputTokens > 0;
  }
  if (event.type === 'message_delta' && event.usage) {
    if (!state.gotInputFromStart && event.usage.input_tokens !== undefined) {
      mergeMessagesUsage(state, event.usage);
    } else state.current.outputTokens = event.usage.output_tokens;
  }
  return event.type === 'message_stop' ? state.current : null;
};

export const tokenUsageFromChatUsage = (u: CU) => {
  const read = u.prompt_tokens_details?.cached_tokens ?? 0;
  return tokenUsage(u.prompt_tokens, u.completion_tokens, read);
};

export const tokenUsageFromChatFrame = (f: ProtocolFrame<CC>) =>
  f.type === 'event' && Array.isArray(f.event.choices) && f.event.choices.length === 0 && f.event.usage ? tokenUsageFromChatUsage(f.event.usage) : null;

export const tokenUsageFromResponsesResult = (r: RR) => {
  const u = r.usage;
  if (!u) return null;
  const read = u.input_tokens_details?.cached_tokens ?? 0;
  return tokenUsage(u.input_tokens, u.output_tokens, read);
};

export const tokenUsageFromResponsesFrame = (f: ProtocolFrame<RE>) => (f.type === 'event' && 'response' in f.event ? tokenUsageFromResponsesResult((f.event as { response: RR }).response) : null);

export const tokenUsageFromGeminiUsageMetadata = (m: G.GeminiUsageMetadata) => {
  const input = m.promptTokenCount ?? 0;
  const output = (m.candidatesTokenCount ?? 0) + (m.thoughtsTokenCount ?? 0);
  return tokenUsage(input, output, m.cachedContentTokenCount ?? 0);
};

export const tokenUsageFromGeminiResponse = (r: GR) => (r.usageMetadata ? tokenUsageFromGeminiUsageMetadata(r.usageMetadata) : null);

export const tokenUsageFromGeminiFrame = (f: ProtocolFrame<GE>) => (f.type === 'event' && !('error' in f.event) ? tokenUsageFromGeminiResponse(f.event) : null);
