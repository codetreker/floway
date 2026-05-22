import type { ChatCompletionChunk, ChatCompletionResponse, ChatReasoningItem } from '../../../shared/protocol/chat-completions.ts';
import type { ResponseOutputItem, ResponseOutputReasoning, ResponsesResult, ResponseStreamEvent } from '../../../shared/protocol/responses.ts';
import type { ResponsesStreamEvent } from '../../shared/protocol/responses.ts';
import { eventFrame, type ProtocolFrame } from '../../shared/stream/types.ts';
import { toResponseReasoningItem } from '../shared/chat-responses-reasoning.ts';
import { makeResponsesReasoningId } from '../shared/reasoning.ts';
import * as responses from '../shared/responses-event-builder.ts';
import { checkWhitespaceOverflow } from '../shared/tool-arguments.ts';

const mapChatCompletionsUsageToResponsesUsage = (usage: ChatCompletionResponse['usage'] | undefined): ResponsesResult['usage'] | undefined =>
  usage
    ? {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        ...(usage.prompt_tokens_details?.cached_tokens !== undefined
          ? {
              input_tokens_details: {
                cached_tokens: usage.prompt_tokens_details.cached_tokens,
              },
            }
          : {}),
      }
    : undefined;

const UPSTREAM_CHAT_COMPLETIONS_MISSING_DONE_MESSAGE = 'Upstream Chat Completions stream ended without a DONE sentinel.';

const upstreamChatCompletionEventsUntilDone = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>): AsyncGenerator<ChatCompletionChunk> {
  for await (const frame of frames) {
    if (frame.type === 'done') return;
    yield frame.event;
  }

  throw new Error(UPSTREAM_CHAT_COMPLETIONS_MISSING_DONE_MESSAGE);
};

interface PendingScalarReasoningItem {
  text: string;
}

interface PendingTextItem {
  outputIndex: number;
  itemId: string;
  text: string;
}

interface FunctionCallStreamItem {
  outputIndex: number;
  itemId: string;
}

interface PendingFunctionCallItem {
  streamItem?: FunctionCallStreamItem;
  callId?: string;
  name?: string;
  arguments: string;
  consecutiveWhitespace: number;
}

type StartedFunctionCallItem = PendingFunctionCallItem & {
  streamItem: FunctionCallStreamItem;
  callId: string;
  name: string;
};

type ChatStreamDelta = ChatCompletionChunk['choices'][0]['delta'];
type ChatStreamToolCalls = NonNullable<ChatStreamDelta['tool_calls']>;
type ChatFinishReason = NonNullable<ChatCompletionChunk['choices'][0]['finish_reason']>;

type DeferredAfterReasoning = { type: 'content'; content: string } | { type: 'tool_calls'; toolCalls: ChatStreamToolCalls };

interface ChatCompletionsToResponsesStreamState {
  responseCreated: boolean;
  outputIndex: number;
  sequenceNumber: number;
  responseId: string;
  model: string;
  outputText: string;
  completedItems: (ResponseOutputItem | undefined)[];
  pendingScalarReasoning?: PendingScalarReasoningItem;
  openText?: PendingTextItem;
  openFunctionCalls: Map<number, PendingFunctionCallItem>;
  deferredAfterReasoning: DeferredAfterReasoning[];
  reasoningItemsSeen: boolean;
  usage?: ResponsesResult['usage'];
  pendingFinishReason?: ChatFinishReason;
  completed: boolean;
}

export const createChatCompletionsToResponsesStreamState = (): ChatCompletionsToResponsesStreamState => ({
  responseCreated: false,
  outputIndex: 0,
  sequenceNumber: 0,
  responseId: '',
  model: '',
  outputText: '',
  completedItems: [],
  openFunctionCalls: new Map(),
  deferredAfterReasoning: [],
  reasoningItemsSeen: false,
  completed: false,
});

const buildResult = (state: ChatCompletionsToResponsesStreamState, status: ResponsesResult['status']): ResponsesResult =>
  responses.result({
    id: state.responseId,
    model: state.model,
    output: state.completedItems.filter((item): item is ResponseOutputItem => item !== undefined),
    outputText: state.outputText,
    status,
    ...(state.usage !== undefined ? { usage: state.usage } : {}),
  });

const ensureResponseCreated = (chunk: ChatCompletionChunk, state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => {
  state.responseId = chunk.id;
  state.model = chunk.model;

  if (chunk.usage) {
    state.usage = mapChatCompletionsUsageToResponsesUsage(chunk.usage);
  }

  if (state.responseCreated) return [];

  state.responseCreated = true;
  const response = buildResult(state, 'in_progress');

  return responses.started(state, response);
};

const emitCompletedReasoningItem = (item: ResponseOutputReasoning, outputIndex: number, state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => {
  state.completedItems[outputIndex] = item;

  return responses.completedReasoning(state, outputIndex, item);
};

const commitPendingScalarReasoning = (state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => {
  if (!state.pendingScalarReasoning) return [];

  const reasoning = state.pendingScalarReasoning;
  state.pendingScalarReasoning = undefined;
  const outputIndex = state.outputIndex++;
  const item = responses.reasoningItem(makeResponsesReasoningId(outputIndex), reasoning.text);

  return emitCompletedReasoningItem(item, outputIndex, state);
};

const closeText = (state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => {
  if (!state.openText) return [];

  const textItem = state.openText;
  state.openText = undefined;

  const item = responses.messageItem(textItem.text);

  state.completedItems[textItem.outputIndex] = item;

  return responses.textDone(state, textItem.outputIndex, textItem.itemId, textItem.text, item);
};

const closeFunctionCalls = (state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => {
  const events: ResponseStreamEvent[] = [];

  for (const functionCall of [...state.openFunctionCalls.values()]
    .filter((item): item is StartedFunctionCallItem => item.streamItem !== undefined && Boolean(item.callId) && Boolean(item.name))
    .sort((a, b) => a.streamItem.outputIndex - b.streamItem.outputIndex)) {
    const { outputIndex, itemId } = functionCall.streamItem;

    const item = responses.functionCallItem(functionCall.callId, functionCall.name, functionCall.arguments, 'completed');

    state.completedItems[outputIndex] = item;
    events.push(...responses.functionCallDone(state, outputIndex, itemId, functionCall.arguments, item));
  }

  state.openFunctionCalls.clear();
  return events;
};

const openScalarReasoning = (state: ChatCompletionsToResponsesStreamState): PendingScalarReasoningItem =>
  (state.pendingScalarReasoning ??= {
    text: '',
  });

const hasReadableSummary = (item: ChatReasoningItem): boolean => item.summary?.some(part => part.text) === true;

const openText = (state: ChatCompletionsToResponsesStreamState): { item: PendingTextItem; events: ResponseStreamEvent[] } => {
  if (state.openText) return { item: state.openText, events: [] };

  const outputIndex = state.outputIndex++;
  const itemId = `msg_${outputIndex}`;
  const item = { outputIndex, itemId, text: '' };
  state.openText = item;

  return {
    item,
    events: responses.textStart(state, outputIndex, itemId),
  };
};

const startFunctionCall = (current: PendingFunctionCallItem, state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => {
  if (current.streamItem || !current.callId || !current.name) {
    return [];
  }

  const outputIndex = state.outputIndex++;
  const streamItem = { outputIndex, itemId: `fc_${outputIndex}` };
  current.streamItem = streamItem;

  const events = responses.itemAdded(state, outputIndex, responses.functionCallItem(current.callId, current.name, '', 'in_progress'));

  if (current.arguments) {
    events.push(...responses.argumentsDelta(state, outputIndex, streamItem.itemId, current.arguments));
  }

  return events;
};

const emitContentDelta = (content: string, state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => {
  const { item, events } = openText(state);
  item.text += content;
  state.outputText += content;
  events.push(...responses.textDelta(state, item.outputIndex, item.itemId, content));

  return events;
};

const emitToolCallsDelta = (toolCalls: ChatStreamToolCalls, state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => {
  const events: ResponseStreamEvent[] = [];
  events.push(...closeText(state));

  for (const toolCall of toolCalls) {
    const current = state.openFunctionCalls.get(toolCall.index) ?? {
      arguments: '',
      consecutiveWhitespace: 0,
    };

    if (toolCall.id) current.callId = toolCall.id;
    if (toolCall.function?.name) current.name = toolCall.function.name;
    state.openFunctionCalls.set(toolCall.index, current);
    events.push(...startFunctionCall(current, state));

    if (!toolCall.function?.arguments) continue;

    const whitespace = checkWhitespaceOverflow(toolCall.function.arguments, current.consecutiveWhitespace);
    current.consecutiveWhitespace = whitespace.count;

    if (whitespace.exceeded) {
      state.completed = true;
      return [
        ...events,
        ...responses.seq(state, [
          {
            type: 'error',
            message: 'Tool call arguments contained excessive whitespace, indicating a degenerate response.',
            code: 'api_error',
          },
        ]),
      ];
    }

    current.arguments += toolCall.function.arguments;

    if (current.streamItem) {
      events.push(...responses.argumentsDelta(state, current.streamItem.outputIndex, current.streamItem.itemId, toolCall.function.arguments));
    }
  }

  return events;
};

const commitReasoningAndReplayDeferredDeltas = (state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => {
  const events: ResponseStreamEvent[] = [];
  events.push(...commitPendingScalarReasoning(state));

  const deferred = state.deferredAfterReasoning;
  state.deferredAfterReasoning = [];

  for (const item of deferred) {
    if (state.completed) break;
    events.push(...(item.type === 'content' ? emitContentDelta(item.content, state) : emitToolCallsDelta(item.toolCalls, state)));
  }

  return events;
};

const finalize = (state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => {
  if (state.completed || state.pendingFinishReason === undefined) return [];

  const events = [...commitReasoningAndReplayDeferredDeltas(state), ...closeText(state), ...closeFunctionCalls(state)];

  if (state.completed) return events;
  state.completed = true;
  const incomplete = state.pendingFinishReason === 'length';
  const status: ResponsesResult['status'] = incomplete ? 'incomplete' : 'completed';

  return [...events, ...responses.terminal(state, buildResult(state, status))];
};

export const translateChatCompletionsChunkToResponsesEvents = (chunk: ChatCompletionChunk, state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => {
  const events = ensureResponseCreated(chunk, state);

  if (chunk.choices.length === 0) {
    return [...events, ...finalize(state)];
  }

  for (const choice of chunk.choices) {
    const readableReasoningItems = choice.delta.reasoning_items?.filter(hasReadableSummary) ?? [];

    if (readableReasoningItems.length) {
      const hadPendingScalarReasoning = state.pendingScalarReasoning !== undefined;
      state.reasoningItemsSeen = true;

      if (hadPendingScalarReasoning) {
        // Chat stream composition can emit legacy scalar reasoning first and a
        // richer item-level `reasoning_items[]` carrier later. Responses SSE
        // items are not retractable, so scalar reasoning remains buffered until
        // either a carrier replaces it or finalization commits it.
        state.pendingScalarReasoning = undefined;
      } else {
        events.push(...commitReasoningAndReplayDeferredDeltas(state));
        events.push(...closeText(state));
      }

      for (const item of readableReasoningItems) {
        const outputIndex = state.outputIndex++;
        events.push(...emitCompletedReasoningItem(toResponseReasoningItem<ResponseOutputReasoning>(item, makeResponsesReasoningId(outputIndex)), outputIndex, state));
      }

      if (hadPendingScalarReasoning) {
        events.push(...commitReasoningAndReplayDeferredDeltas(state));
        if (state.completed) return events;
      }
    } else if (choice.delta.reasoning_text) {
      if (!state.reasoningItemsSeen) {
        if (!state.pendingScalarReasoning) events.push(...closeText(state));
        const reasoning = openScalarReasoning(state);

        if (choice.delta.reasoning_text) {
          reasoning.text += choice.delta.reasoning_text;
        }
      }
    }

    if (choice.delta.content) {
      if (state.pendingScalarReasoning) {
        state.deferredAfterReasoning.push({
          type: 'content',
          content: choice.delta.content,
        });
      } else {
        events.push(...emitContentDelta(choice.delta.content, state));
      }
    }

    if (choice.delta.tool_calls?.length) {
      if (state.pendingScalarReasoning) {
        state.deferredAfterReasoning.push({
          type: 'tool_calls',
          toolCalls: choice.delta.tool_calls,
        });
      } else {
        events.push(...emitToolCallsDelta(choice.delta.tool_calls, state));
        if (state.completed) return events;
      }
    }

    if (choice.finish_reason) {
      state.pendingFinishReason = choice.finish_reason;
    }
  }

  return events;
};

export const flushChatCompletionsToResponsesEvents = (state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => finalize(state);

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const state = createChatCompletionsToResponsesStreamState();

  for await (const chunk of upstreamChatCompletionEventsUntilDone(frames)) {
    for (const event of translateChatCompletionsChunkToResponsesEvents(chunk, state)) {
      yield eventFrame(event);
    }
  }

  for (const event of flushChatCompletionsToResponsesEvents(state)) {
    yield eventFrame(event);
  }
};
