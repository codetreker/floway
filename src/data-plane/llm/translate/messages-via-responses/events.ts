import { translateResponsesToMessagesResponse } from './result.ts';
import type { MessagesStreamEventData } from '../../../shared/protocol/messages.ts';
import type { ResponsesResult, ResponseStreamEvent } from '../../../shared/protocol/responses.ts';
import { messagesResultToEvents } from '../../shared/protocol/messages.ts';
import { type EventFrame, eventFrame, type ProtocolFrame } from '../../shared/stream/types.ts';
import { packReasoningSignature } from '../shared/messages-responses-signature.ts';
import { createResponsesOutputOrderState, recordResponseOutputOrderEvent, type ResponsesOutputOrderState, shouldDeferForEarlierResponseOutput } from '../shared/responses-stream-order.ts';
import { isResponseCompletionEvent, type ResponseEvent, responsePartKey, type UpstreamResponseStreamEvent } from '../shared/responses-stream.ts';
import { checkWhitespaceOverflow } from '../shared/tool-arguments.ts';

const UPSTREAM_RESPONSES_MISSING_TERMINAL_MESSAGE = 'Upstream Responses stream ended without a terminal event.';

const upstreamResponsesEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<UpstreamResponseStreamEvent>>): AsyncGenerator<UpstreamResponseStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') continue;

    yield frame.event;
    if (frame.event.type === 'response.completed' || frame.event.type === 'response.incomplete' || frame.event.type === 'response.failed' || frame.event.type === 'error') {
      return;
    }
  }

  throw new Error(UPSTREAM_RESPONSES_MISSING_TERMINAL_MESSAGE);
};

const hasResponsePartForOutput = (keys: Set<string>, outputIndex: number): boolean => {
  const prefix = `${outputIndex}:`;
  for (const key of keys) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
};

interface ResponsesToMessagesStreamState {
  messageCompleted: boolean;
  nextBlockIndex: number;
  blockIndexByKey: Map<string, number>;
  openBlocks: Set<number>;
  emittedReasoningSummaryKeys: Set<string>;
  emittedTextContentKeys: Set<string>;
  emittedFunctionArgumentOutputIndexes: Set<number>;
  outputOrder: ResponsesOutputOrderState;
  functionCallState: Map<
    number,
    {
      blockIndex: number;
      toolCallId: string;
      name: string;
      consecutiveWhitespace: number;
    }
  >;
}

type ContentBlockInit = { type: 'text'; text: '' } | { type: 'thinking'; thinking: '' } | { type: 'redacted_thinking'; data: string };

const openBlock = (state: ResponsesToMessagesStreamState, key: string, contentBlock: ContentBlockInit, events: MessagesStreamEventData[]): number => {
  let blockIndex = state.blockIndexByKey.get(key);

  if (blockIndex === undefined) {
    blockIndex = state.nextBlockIndex++;
    state.blockIndexByKey.set(key, blockIndex);
  }

  if (!state.openBlocks.has(blockIndex)) {
    closeOpenBlocks(state, events);
    events.push({
      type: 'content_block_start',
      index: blockIndex,
      content_block: contentBlock,
    });
    state.openBlocks.add(blockIndex);
  }

  return blockIndex;
};

const openTextBlock = (state: ResponsesToMessagesStreamState, outputIndex: number, contentIndex: number, events: MessagesStreamEventData[]): number =>
  openBlock(state, `${outputIndex}:${contentIndex}`, { type: 'text', text: '' }, events);

const openThinkingBlock = (state: ResponsesToMessagesStreamState, outputIndex: number, events: MessagesStreamEventData[]): number =>
  openBlock(state, `${outputIndex}:0`, { type: 'thinking', thinking: '' }, events);

const openRedactedThinkingBlock = (state: ResponsesToMessagesStreamState, outputIndex: number, signature: string, events: MessagesStreamEventData[]): number =>
  openBlock(state, `${outputIndex}:0`, { type: 'redacted_thinking', data: signature }, events);

const closeOpenBlocks = (state: ResponsesToMessagesStreamState, events: MessagesStreamEventData[]): void => {
  for (const blockIndex of state.openBlocks) {
    events.push({ type: 'content_block_stop', index: blockIndex });
  }

  state.openBlocks.clear();
};

const closeAllBlocks = (state: ResponsesToMessagesStreamState, events: MessagesStreamEventData[]): void => {
  closeOpenBlocks(state, events);
  state.functionCallState.clear();
};

const handleResponseCreated = (response: ResponsesResult): MessagesStreamEventData[] => {
  const cachedTokens = response.usage?.input_tokens_details?.cached_tokens;

  return [
    {
      type: 'message_start',
      message: {
        id: response.id,
        type: 'message',
        role: 'assistant',
        content: [],
        model: response.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: (response.usage?.input_tokens ?? 0) - (cachedTokens ?? 0),
          output_tokens: 0,
          ...(cachedTokens !== undefined ? { cache_read_input_tokens: cachedTokens } : {}),
        },
      },
    },
  ];
};

const handleOutputItemAdded = (event: ResponseEvent<'response.output_item.added'>, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  if (event.item.type !== 'function_call') return [];

  const blockIndex = state.nextBlockIndex++;
  const toolCallId = event.item.call_id ?? `tool_${blockIndex}`;
  const name = event.item.name ?? 'function';

  state.functionCallState.set(event.output_index, {
    blockIndex,
    toolCallId,
    name,
    consecutiveWhitespace: 0,
  });

  const events: MessagesStreamEventData[] = [];
  closeOpenBlocks(state, events);
  events.push({
    type: 'content_block_start',
    index: blockIndex,
    content_block: { type: 'tool_use', id: toolCallId, name, input: {} },
  });
  state.openBlocks.add(blockIndex);

  if (event.item.arguments.length > 0) {
    events.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'input_json_delta', partial_json: event.item.arguments },
    });
    state.emittedFunctionArgumentOutputIndexes.add(event.output_index);
  }

  return events;
};

const handleOutputItemDone = (event: ResponseEvent<'response.output_item.done'>, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  if (event.item.type !== 'reasoning') return [];

  const encryptedContent = event.item.encrypted_content;
  const hasEncryptedContent = encryptedContent !== undefined;
  const hasEmittedSummary = hasResponsePartForOutput(state.emittedReasoningSummaryKeys, event.output_index);
  const trimmedSummary = event.item.summary
    .map(part => part.text)
    .join('')
    .trim();

  // No prior summary delta and no usable summary text: either round-trip the
  // opaque blob as `redacted_thinking{data}` (the valid signature-only Messages
  // shape) or drop entirely when there is nothing the target can verify. The
  // Responses item id is packed into the signature/data slot so upstream
  // reasoning-continuity checks can pass on the next turn; see
  // `../shared/messages-responses-signature.ts`.
  if (!hasEmittedSummary && trimmedSummary === '') {
    if (hasEncryptedContent) {
      const events: MessagesStreamEventData[] = [];
      openRedactedThinkingBlock(state, event.output_index, packReasoningSignature(event.item.id, encryptedContent), events);
      return events;
    }
    return [];
  }

  const events: MessagesStreamEventData[] = [];
  const blockIndex = openThinkingBlock(state, event.output_index, events);

  for (const [summaryIndex, part] of event.item.summary.entries()) {
    const key = responsePartKey(event.output_index, summaryIndex);
    if (!part.text || state.emittedReasoningSummaryKeys.has(key)) continue;

    events.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'thinking_delta', thinking: part.text },
    });
    state.emittedReasoningSummaryKeys.add(key);
  }

  if (hasEncryptedContent) {
    events.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: {
        type: 'signature_delta',
        signature: packReasoningSignature(event.item.id, encryptedContent),
      },
    });
  }

  return events;
};

const handleThinkingDelta = (event: ResponseEvent<'response.reasoning_summary_text.delta'>, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];
  const blockIndex = openThinkingBlock(state, event.output_index, events);
  events.push({
    type: 'content_block_delta',
    index: blockIndex,
    delta: { type: 'thinking_delta', thinking: event.delta },
  });
  state.emittedReasoningSummaryKeys.add(responsePartKey(event.output_index, event.summary_index));
  return events;
};

const handleThinkingDone = (event: ResponseEvent<'response.reasoning_summary_text.done'>, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];
  const blockIndex = openThinkingBlock(state, event.output_index, events);
  const key = responsePartKey(event.output_index, event.summary_index);

  if (event.text && !state.emittedReasoningSummaryKeys.has(key)) {
    events.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'thinking_delta', thinking: event.text },
    });
    state.emittedReasoningSummaryKeys.add(key);
  }

  return events;
};

const handleTextDelta = (event: ResponseEvent<'response.output_text.delta'>, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  if (!event.delta) return [];

  const events: MessagesStreamEventData[] = [];
  const blockIndex = openTextBlock(state, event.output_index, event.content_index, events);
  events.push({
    type: 'content_block_delta',
    index: blockIndex,
    delta: { type: 'text_delta', text: event.delta },
  });
  state.emittedTextContentKeys.add(responsePartKey(event.output_index, event.content_index));
  return events;
};

const handleTextDone = (event: ResponseEvent<'response.output_text.done'>, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];
  const blockIndex = openTextBlock(state, event.output_index, event.content_index, events);

  const key = responsePartKey(event.output_index, event.content_index);
  if (event.text && !state.emittedTextContentKeys.has(key)) {
    events.push({
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'text_delta', text: event.text },
    });
    state.emittedTextContentKeys.add(key);
  }

  return events;
};

const handleContentPartDone = (event: ResponseEvent<'response.content_part.done'>, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  if (event.part.type !== 'refusal') return [];

  const key = responsePartKey(event.output_index, event.content_index);
  if (!event.part.refusal || state.emittedTextContentKeys.has(key)) return [];

  const events: MessagesStreamEventData[] = [];
  const blockIndex = openTextBlock(state, event.output_index, event.content_index, events);
  events.push({
    type: 'content_block_delta',
    index: blockIndex,
    delta: { type: 'text_delta', text: event.part.refusal },
  });
  state.emittedTextContentKeys.add(key);
  return events;
};

const handleFunctionArgumentsDelta = (event: ResponseEvent<'response.function_call_arguments.delta'>, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  if (!event.delta) return [];

  const functionCallState = state.functionCallState.get(event.output_index);
  if (!functionCallState) return [];

  const whitespace = checkWhitespaceOverflow(event.delta, functionCallState.consecutiveWhitespace);
  functionCallState.consecutiveWhitespace = whitespace.count;

  if (whitespace.exceeded) {
    const events: MessagesStreamEventData[] = [];
    console.warn('Infinite whitespace in Responses function call args, aborting');
    closeAllBlocks(state, events);
    state.messageCompleted = true;
    events.push({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'Tool call arguments contained excessive whitespace.',
      },
    });
    return events;
  }

  state.emittedFunctionArgumentOutputIndexes.add(event.output_index);

  return [
    {
      type: 'content_block_delta',
      index: functionCallState.blockIndex,
      delta: { type: 'input_json_delta', partial_json: event.delta },
    },
  ];
};

const handleFunctionArgumentsDone = (event: ResponseEvent<'response.function_call_arguments.done'>, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  const functionCallState = state.functionCallState.get(event.output_index);
  if (!functionCallState) return [];

  state.functionCallState.delete(event.output_index);

  if (!event.arguments || state.emittedFunctionArgumentOutputIndexes.has(event.output_index)) {
    return [];
  }

  state.emittedFunctionArgumentOutputIndexes.add(event.output_index);

  return [
    {
      type: 'content_block_delta',
      index: functionCallState.blockIndex,
      delta: { type: 'input_json_delta', partial_json: event.arguments },
    },
  ];
};

const handleCompleted = (response: ResponsesResult, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];
  closeAllBlocks(state, events);

  const messagesResponse = translateResponsesToMessagesResponse(response);
  events.push(
    {
      type: 'message_delta',
      delta: {
        stop_reason: messagesResponse.stop_reason,
        stop_sequence: messagesResponse.stop_sequence,
      },
      usage: messagesResponse.usage,
    },
    { type: 'message_stop' },
  );
  state.messageCompleted = true;
  return events;
};

const handleStreamError = (state: ResponsesToMessagesStreamState, message: string): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];
  closeAllBlocks(state, events);
  state.messageCompleted = true;
  events.push({
    type: 'error',
    error: {
      type: 'api_error',
      message,
    },
  });
  return events;
};

const handleFailed = (response: ResponsesResult, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] =>
  handleStreamError(state, response.error?.message ?? 'Response failed due to unknown error.');

const handleError = (event: ResponseEvent<'error'>, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] =>
  handleStreamError(state, typeof event.message === 'string' ? event.message : 'An unexpected error occurred during streaming.');

export const createResponsesToMessagesStreamState = (): ResponsesToMessagesStreamState => ({
  messageCompleted: false,
  nextBlockIndex: 0,
  blockIndexByKey: new Map(),
  openBlocks: new Set(),
  emittedReasoningSummaryKeys: new Set(),
  emittedTextContentKeys: new Set(),
  emittedFunctionArgumentOutputIndexes: new Set(),
  outputOrder: createResponsesOutputOrderState(),
  functionCallState: new Map(),
});

const translateReadyResponseEvent = (event: ResponseStreamEvent, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  recordResponseOutputOrderEvent(event, state.outputOrder, () => true);

  switch (event.type) {
  case 'response.created':
    return handleResponseCreated((event as ResponseEvent<'response.created'>).response);
  case 'response.output_item.added':
    return handleOutputItemAdded(event as ResponseEvent<'response.output_item.added'>, state);
  case 'response.output_item.done':
    return handleOutputItemDone(event as ResponseEvent<'response.output_item.done'>, state);
  case 'response.reasoning_summary_text.delta':
    return handleThinkingDelta(event as ResponseEvent<'response.reasoning_summary_text.delta'>, state);
  case 'response.reasoning_summary_text.done':
    return handleThinkingDone(event as ResponseEvent<'response.reasoning_summary_text.done'>, state);
  case 'response.output_text.delta':
    return handleTextDelta(event as ResponseEvent<'response.output_text.delta'>, state);
  case 'response.output_text.done':
    return handleTextDone(event as ResponseEvent<'response.output_text.done'>, state);
  case 'response.content_part.done':
    return handleContentPartDone(event as ResponseEvent<'response.content_part.done'>, state);
  case 'response.function_call_arguments.delta':
    return handleFunctionArgumentsDelta(event as ResponseEvent<'response.function_call_arguments.delta'>, state);
  case 'response.function_call_arguments.done':
    return handleFunctionArgumentsDone(event as ResponseEvent<'response.function_call_arguments.done'>, state);
  case 'response.completed':
  case 'response.incomplete':
    return handleCompleted((event as ResponseEvent<'response.completed' | 'response.incomplete'>).response, state);
  case 'response.failed':
    return handleFailed((event as ResponseEvent<'response.failed'>).response, state);
  case 'error':
    return handleError(event as ResponseEvent<'error'>, state);
  case 'ping':
    return [{ type: 'ping' }];
  default:
    return [];
  }
};

const takeNextReadyDeferredResponseEvent = (state: ResponsesToMessagesStreamState): ResponseStreamEvent | undefined => {
  const nextReadyIndex = state.outputOrder.deferredEvents.findIndex(event => !shouldDeferForEarlierResponseOutput(event, state.outputOrder));
  if (nextReadyIndex === -1) return undefined;

  const [event] = state.outputOrder.deferredEvents.splice(nextReadyIndex, 1);
  return event;
};

const flushReadyDeferredMessagesEvents = (state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];
  while (!state.messageCompleted && state.outputOrder.deferredEvents.length > 0) {
    const event = takeNextReadyDeferredResponseEvent(state);
    if (!event) break;
    events.push(...translateReadyResponseEvent(event, state));
  }
  return events;
};

export const translateResponsesStreamEventToMessagesEvents = (event: ResponseStreamEvent, state: ResponsesToMessagesStreamState): MessagesStreamEventData[] => {
  if (state.messageCompleted) return [];
  if (shouldDeferForEarlierResponseOutput(event, state.outputOrder)) {
    state.outputOrder.deferredEvents.push(event);
    return [];
  }

  const events = translateReadyResponseEvent(event, state);
  if (event.type === 'response.output_item.done') {
    events.push(...flushReadyDeferredMessagesEvents(state));
  }
  return events;
};

const startsStructuredMessagesStream = (event: ResponseStreamEvent): boolean =>
  event.type === 'response.output_item.added' ||
  event.type === 'response.output_item.done' ||
  event.type === 'response.reasoning_summary_text.delta' ||
  event.type === 'response.reasoning_summary_text.done' ||
  event.type === 'response.output_text.delta' ||
  event.type === 'response.output_text.done' ||
  event.type === 'response.function_call_arguments.delta' ||
  event.type === 'response.function_call_arguments.done';

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<UpstreamResponseStreamEvent>>): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> {
  const state = createResponsesToMessagesStreamState();
  let streamingCommitted = false;
  const pendingFrames: Array<EventFrame<MessagesStreamEventData>> = [];

  for await (const event of upstreamResponsesEventsUntilTerminal(frames)) {
    if (!streamingCommitted && startsStructuredMessagesStream(event)) {
      streamingCommitted = true;
      for (const pending of pendingFrames) yield pending;
      pendingFrames.length = 0;
    }

    if (!streamingCommitted && isResponseCompletionEvent(event)) {
      yield* messagesResultToEvents(translateResponsesToMessagesResponse(event.response));
      return;
    }

    for (const translated of translateResponsesStreamEventToMessagesEvents(event, state)) {
      const translatedFrame = eventFrame(translated);
      if (streamingCommitted) {
        yield translatedFrame;
      } else {
        pendingFrames.push(translatedFrame);
      }
    }
  }

  if (!streamingCommitted) {
    for (const pending of pendingFrames) yield pending;
  }
};
