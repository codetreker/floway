import type {
  MessagesContentBlockDeltaEvent,
  MessagesContentBlockStartEvent,
  MessagesContentBlockStopEvent,
  MessagesMessageDeltaEvent,
  MessagesMessageStartEvent,
  MessagesStreamEventData,
} from '../../../shared/protocol/messages.ts';
import type { ResponseOutputItem, ResponsesResult, ResponseStreamEvent } from '../../../shared/protocol/responses.ts';
import type { ResponsesStreamEvent } from '../../shared/protocol/responses.ts';
import { eventFrame, type ProtocolFrame } from '../../shared/stream/types.ts';
import { makeResponsesReasoningId } from '../shared/reasoning.ts';
import * as responses from '../shared/responses-event-builder.ts';

const UPSTREAM_MESSAGES_MISSING_TERMINAL_MESSAGE = 'Upstream Messages stream ended without a message_stop event.';

const upstreamMessagesEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>): AsyncGenerator<MessagesStreamEventData> {
  for await (const frame of frames) {
    if (frame.type === 'done') continue;

    yield frame.event;
    if (frame.event.type === 'message_stop' || frame.event.type === 'error') {
      return;
    }
  }

  throw new Error(UPSTREAM_MESSAGES_MISSING_TERMINAL_MESSAGE);
};

type OutputBlockInfo =
  | {
    type: 'thinking';
    outputIndex: number;
    itemId: string;
    thinkingText: string;
  }
  | {
    type: 'text';
    outputIndex: number;
    itemId: string;
    blockText: string;
  }
  | {
    type: 'tool_use';
    outputIndex: number;
    itemId: string;
    toolCallId: string;
    toolName: string;
    toolArguments: string;
  };

interface MessagesToResponsesStreamState {
  responseId: string;
  model: string;
  outputIndex: number;
  sequenceNumber: number;
  blockMap: Map<number, OutputBlockInfo>;
  accumulatedText: string;
  completedItems: ResponseOutputItem[];
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  stopReason?: MessagesMessageDeltaEvent['delta']['stop_reason'];
}

const buildResult = (state: MessagesToResponsesStreamState, status: ResponsesResult['status']): ResponsesResult => {
  const inputTokens = state.inputTokens + (state.cacheReadInputTokens ?? 0) + (state.cacheCreationInputTokens ?? 0);

  return responses.result({
    id: state.responseId,
    model: state.model,
    output: state.completedItems,
    outputText: state.accumulatedText,
    status,
    usage: responses.usage(inputTokens, state.outputTokens, state.cacheReadInputTokens),
  });
};

const handleMessageStart = (event: MessagesMessageStartEvent, state: MessagesToResponsesStreamState): ResponseStreamEvent[] => {
  state.inputTokens = event.message.usage.input_tokens;
  state.cacheReadInputTokens = event.message.usage.cache_read_input_tokens;
  state.cacheCreationInputTokens = event.message.usage.cache_creation_input_tokens;

  const response = buildResult(state, 'in_progress');

  return responses.started(state, response);
};

const handleContentBlockStart = (event: MessagesContentBlockStartEvent, state: MessagesToResponsesStreamState): ResponseStreamEvent[] => {
  switch (event.content_block.type) {
  case 'thinking': {
    const outputIndex = state.outputIndex++;
    const itemId = makeResponsesReasoningId(outputIndex);
    state.blockMap.set(event.index, {
      type: 'thinking',
      outputIndex,
      itemId,
      thinkingText: '',
    });

    return responses.reasoningStart(state, outputIndex, itemId);
  }
  case 'redacted_thinking':
    return [];
  case 'text': {
    const outputIndex = state.outputIndex++;
    const itemId = `msg_${outputIndex}`;
    state.blockMap.set(event.index, {
      type: 'text',
      outputIndex,
      itemId,
      blockText: '',
    });

    return responses.textStart(state, outputIndex, itemId);
  }
  case 'tool_use': {
    const outputIndex = state.outputIndex++;
    const itemId = `fc_${outputIndex}`;
    const info: OutputBlockInfo = {
      type: 'tool_use',
      outputIndex,
      itemId,
      toolCallId: event.content_block.id,
      toolName: event.content_block.name,
      toolArguments: '',
    };
    state.blockMap.set(event.index, info);

    return responses.itemAdded(state, outputIndex, responses.functionCallItem(info.toolCallId, info.toolName, info.toolArguments, 'in_progress'));
  }
  default:
    return [];
  }
};

const handleContentBlockDelta = (event: MessagesContentBlockDeltaEvent, state: MessagesToResponsesStreamState): ResponseStreamEvent[] => {
  const info = state.blockMap.get(event.index);
  if (!info) return [];

  switch (info.type) {
  case 'thinking':
    if (event.delta.type === 'thinking_delta') {
      info.thinkingText += event.delta.thinking;
      return responses.reasoningDelta(state, info.outputIndex, info.itemId, event.delta.thinking);
    }
    return [];
  case 'text':
    if (event.delta.type !== 'text_delta') return [];
    info.blockText += event.delta.text;
    state.accumulatedText += event.delta.text;
    return responses.textDelta(state, info.outputIndex, info.itemId, event.delta.text);
  case 'tool_use':
    if (event.delta.type !== 'input_json_delta') return [];
    info.toolArguments += event.delta.partial_json;
    return responses.argumentsDelta(state, info.outputIndex, info.itemId, event.delta.partial_json);
  }
};

const handleContentBlockStop = (event: MessagesContentBlockStopEvent, state: MessagesToResponsesStreamState): ResponseStreamEvent[] => {
  const info = state.blockMap.get(event.index);
  if (!info) return [];

  state.blockMap.delete(event.index);

  if (info.type === 'thinking') {
    const summaryText = info.thinkingText;
    const itemId = info.itemId;
    const item = responses.reasoningItem(itemId, summaryText);

    state.completedItems.push(item);

    return responses.reasoningDone(state, info.outputIndex, itemId, summaryText, item);
  }

  if (info.type === 'text') {
    const item = responses.messageItem(info.blockText);

    state.completedItems.push(item);

    return responses.textDone(state, info.outputIndex, info.itemId, info.blockText, item);
  }

  const item = responses.functionCallItem(info.toolCallId, info.toolName, info.toolArguments, 'completed');

  state.completedItems.push(item);

  return responses.functionCallDone(state, info.outputIndex, info.itemId, info.toolArguments, item);
};

export const createMessagesToResponsesStreamState = (responseId: string, model: string): MessagesToResponsesStreamState => ({
  responseId,
  model,
  outputIndex: 0,
  sequenceNumber: 0,
  blockMap: new Map(),
  accumulatedText: '',
  completedItems: [],
  inputTokens: 0,
  outputTokens: 0,
});

export const translateMessagesEventToResponsesEvents = (event: MessagesStreamEventData, state: MessagesToResponsesStreamState): ResponseStreamEvent[] => {
  switch (event.type) {
  case 'message_start':
    return handleMessageStart(event, state);
  case 'content_block_start':
    return handleContentBlockStart(event, state);
  case 'content_block_delta':
    return handleContentBlockDelta(event, state);
  case 'content_block_stop':
    return handleContentBlockStop(event, state);
  case 'message_delta': {
    if (event.delta.stop_reason !== undefined) {
      state.stopReason = event.delta.stop_reason;
    }
    if (event.usage) {
      state.outputTokens = event.usage.output_tokens;
    }
    return [];
  }
  case 'message_stop': {
    const status: ResponsesResult['status'] = state.stopReason === 'max_tokens' ? 'incomplete' : 'completed';
    const response = buildResult(state, status);

    return responses.terminal(state, response);
  }
  case 'ping':
    return responses.seq(state, [{ type: 'ping' }]);
  case 'error':
    return responses.seq(state, [
      {
        type: 'error',
        message: event.error.message,
        code: event.error.type,
      },
    ]);
  }
};

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>,
  responseId: string,
  model: string,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const state = createMessagesToResponsesStreamState(responseId, model);

  for await (const event of upstreamMessagesEventsUntilTerminal(frames)) {
    for (const translated of translateMessagesEventToResponsesEvents(event, state)) {
      yield eventFrame(translated);
    }
  }
};
