import { mapFinishReason, mapUsage } from './result.ts';
import { chatCompletionsErrorPayloadMessage } from '../../../shared/protocol/chat-completions-errors.ts';
import type { ChatCompletionChunk, Delta } from '../../../shared/protocol/chat-completions.ts';
import type { GeminiCandidate, GeminiGenerateContentResponse, GeminiPart, GeminiStreamEvent, GeminiUsageMetadata } from '../../../shared/protocol/gemini.ts';
import { eventFrame, type ProtocolFrame } from '../../shared/stream/types.ts';
import { appendGeminiThoughtSignature, flushGeminiThoughtSignature, type GeminiThoughtSignatureState, parseStrictJsonObject, signGeminiPart } from '../shared/gemini.ts';

const UPSTREAM_CHAT_COMPLETIONS_MISSING_DONE_MESSAGE = 'Upstream Chat Completions stream ended without a DONE sentinel.';

const upstreamChatCompletionEventsUntilDone = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>): AsyncGenerator<ChatCompletionChunk> {
  for await (const frame of frames) {
    if (frame.type === 'done') return;
    yield frame.event;
  }

  throw new Error(UPSTREAM_CHAT_COMPLETIONS_MISSING_DONE_MESSAGE);
};

type ChatStreamChoice = ChatCompletionChunk['choices'][0];
type ChatToolCallDelta = NonNullable<Delta['tool_calls']>[0];

interface ChatToolCallDraft {
  id?: string;
  name?: string;
  argsJson: string;
}

interface ChoiceState extends GeminiThoughtSignatureState {
  toolCalls: Record<number, ChatToolCallDraft>;
}

const getChoiceState = (states: Record<number, ChoiceState>, index: number): ChoiceState => {
  states[index] ??= { toolCalls: {} };
  return states[index];
};

const accumulateToolCalls = (toolCalls: ChatToolCallDelta[], state: ChoiceState): void => {
  for (const toolCall of toolCalls) {
    const current = (state.toolCalls[toolCall.index] ??= { argsJson: '' });
    if (toolCall.id !== undefined) current.id = toolCall.id;
    if (toolCall.function?.name !== undefined) {
      current.name = toolCall.function.name;
    }
    if (toolCall.function?.arguments !== undefined) {
      current.argsJson += toolCall.function.arguments;
    }
  }
};

const flushToolCallParts = (state: ChoiceState): GeminiPart[] => {
  const parts: GeminiPart[] = [];

  for (const [_index, toolCall] of Object.entries(state.toolCalls).sort(([left], [right]) => Number(left) - Number(right))) {
    if (!toolCall.name) continue;

    parts.push(
      signGeminiPart(state, {
        functionCall: {
          ...(toolCall.id !== undefined ? { id: toolCall.id } : {}),
          name: toolCall.name,
          args: toolCall.argsJson ? parseStrictJsonObject(toolCall.argsJson, 'Chat Completions tool call arguments') : {},
        },
      }),
    );
  }

  state.toolCalls = {};
  return parts;
};

const buildCandidate = (choice: ChatStreamChoice, state: ChoiceState): GeminiCandidate | null => {
  const parts: GeminiPart[] = [];
  const { delta } = choice;

  if (typeof delta.reasoning_text === 'string') {
    parts.push({ text: delta.reasoning_text, thought: true });
  }

  if (typeof delta.reasoning_opaque === 'string') {
    appendGeminiThoughtSignature(state, delta.reasoning_opaque);
  }

  if (typeof delta.content === 'string') {
    parts.push(signGeminiPart(state, { text: delta.content }));
  }

  if (delta.tool_calls) accumulateToolCalls(delta.tool_calls, state);

  const finishReason = mapFinishReason(choice.finish_reason);
  if (finishReason) {
    parts.push(...flushToolCallParts(state));
    parts.push(...flushGeminiThoughtSignature(state));
  }

  if (!parts.length && !finishReason) return null;

  return {
    index: choice.index,
    content: { role: 'model', parts },
    ...(finishReason !== undefined ? { finishReason } : {}),
  };
};

const translateChunk = (chunk: ChatCompletionChunk, states: Record<number, ChoiceState>): GeminiGenerateContentResponse | null => {
  const candidates: GeminiCandidate[] = [];

  for (const choice of chunk.choices) {
    const candidate = buildCandidate(choice, getChoiceState(states, choice.index));

    if (candidate) candidates.push(candidate);
  }

  const usageMetadata = mapUsage(chunk.usage);

  if (!candidates.length && !usageMetadata) return null;

  return {
    ...(candidates.length ? { candidates } : {}),
    ...(usageMetadata ? { usageMetadata } : {}),
  };
};

const throwOnChatErrorPayload = (chunk: ChatCompletionChunk): void => {
  const message = chatCompletionsErrorPayloadMessage(chunk);
  if (!message) return;

  throw new Error(`Upstream Chat Completions stream error: ${message}`, {
    cause: chunk,
  });
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
  const states: Record<number, ChoiceState> = {};
  let pendingUsageMetadata: GeminiUsageMetadata | undefined;
  const deferredFinalCandidates: GeminiCandidate[] = [];

  for await (const chunk of upstreamChatCompletionEventsUntilDone(frames)) {
    throwOnChatErrorPayload(chunk);

    const response = translateChunk(chunk, states);
    if (!response) continue;

    if (response.usageMetadata) {
      pendingUsageMetadata = response.usageMetadata;
    }

    const candidates = response.candidates ?? [];
    const finishedCandidates = candidates.filter(candidate => candidate.finishReason !== undefined);
    const nonFinalCandidates = candidates.filter(candidate => candidate.finishReason === undefined);

    if (nonFinalCandidates.length) {
      yield eventFrame({ candidates: nonFinalCandidates });
    }

    if (finishedCandidates.length) {
      deferredFinalCandidates.push(...finishedCandidates);
    }
  }

  if (deferredFinalCandidates.length) {
    yield eventFrame({
      candidates: deferredFinalCandidates,
      ...(pendingUsageMetadata ? { usageMetadata: pendingUsageMetadata } : {}),
    });
  }
};
