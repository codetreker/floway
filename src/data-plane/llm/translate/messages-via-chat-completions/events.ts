import type { ChatCompletionChunk } from '../../../shared/protocol/chat-completions.ts';
import type { MessagesContentBlockDeltaEvent, MessagesContentBlockStartEvent, MessagesResponse, MessagesStreamEventData } from '../../../shared/protocol/messages.ts';
import { eventFrame, type ProtocolFrame } from '../../shared/stream/types.ts';
import { checkWhitespaceOverflow } from '../shared/tool-arguments.ts';

const toMessagesId = (id: string): string => (id.startsWith('msg_') ? id : `msg_${id.replace(/^chatcmpl-/, '')}`);

const mapChatCompletionsFinishReasonToMessagesStopReason = (finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null): MessagesResponse['stop_reason'] => {
  if (finishReason === null) return null;

  switch (finishReason) {
  case 'stop':
    return 'end_turn';
  case 'length':
    return 'max_tokens';
  case 'tool_calls':
    return 'tool_use';
  case 'content_filter':
    return 'refusal';
  }
};

interface ChatCompletionsUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export const mapChatCompletionsUsageToMessagesUsage = (usage?: ChatCompletionsUsage): MessagesResponse['usage'] => {
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens;

  return {
    input_tokens: (usage?.prompt_tokens ?? 0) - (cachedTokens ?? 0),
    output_tokens: usage?.completion_tokens ?? 0,
    ...(cachedTokens !== undefined ? { cache_read_input_tokens: cachedTokens } : {}),
  };
};

const UPSTREAM_CHAT_COMPLETIONS_MISSING_DONE_MESSAGE = 'Upstream Chat Completions stream ended without a DONE sentinel.';

const upstreamChatCompletionEventsUntilDone = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>): AsyncGenerator<ChatCompletionChunk> {
  for await (const frame of frames) {
    if (frame.type === 'done') return;
    yield frame.event;
  }

  throw new Error(UPSTREAM_CHAT_COMPLETIONS_MISSING_DONE_MESSAGE);
};

type ChatStreamDelta = ChatCompletionChunk['choices'][0]['delta'];
type ChatStreamToolCalls = NonNullable<ChatStreamDelta['tool_calls']>;
type MessagesContentBlock = MessagesContentBlockStartEvent['content_block'];
type MessagesContentDelta = MessagesContentBlockDeltaEvent['delta'];

type DeferredAfterThinking = { type: 'content'; content: string } | { type: 'tool_calls'; toolCalls: ChatStreamToolCalls };

type OpenContentBlock = 'text' | 'thinking' | 'tool_use';

interface ChatCompletionsToMessagesStreamState {
  messageStartSent: boolean;
  contentBlockIndex: number;
  openBlock?: OpenContentBlock;
  toolCalls: Record<
    number,
    {
      messagesBlockIndex: number;
      consecutiveWhitespace: number;
    }
  >;
  aborted?: boolean;
  pendingReasoningOpaque?: string;
  pendingThinkingSignature?: string;
  deferredAfterThinking: DeferredAfterThinking[];
  pendingFinishReason?: ChatCompletionChunk['choices'][0]['finish_reason'];
  pendingUsage?: ChatCompletionChunk['usage'];
  finalMessageSent?: boolean;
}

const hasPendingReasoning = (state: ChatCompletionsToMessagesStreamState): boolean => state.openBlock === 'thinking' || state.pendingReasoningOpaque !== undefined;

const startContentBlock = (state: ChatCompletionsToMessagesStreamState, events: MessagesStreamEventData[], openBlock: OpenContentBlock, contentBlock: MessagesContentBlock): void => {
  events.push({
    type: 'content_block_start',
    index: state.contentBlockIndex,
    content_block: contentBlock,
  });
  state.openBlock = openBlock;
};

const emitContentBlockDelta = (state: ChatCompletionsToMessagesStreamState, events: MessagesStreamEventData[], delta: MessagesContentDelta, index = state.contentBlockIndex): void => {
  events.push({ type: 'content_block_delta', index, delta });
};

const closeCurrentBlock = (state: ChatCompletionsToMessagesStreamState, events: MessagesStreamEventData[]): void => {
  if (state.openBlock === undefined) return;

  events.push({ type: 'content_block_stop', index: state.contentBlockIndex });
  state.contentBlockIndex++;
  state.openBlock = undefined;
};

const attachOpaqueToOpenThinkingBlock = (state: ChatCompletionsToMessagesStreamState): boolean => {
  if (state.openBlock !== 'thinking' || state.pendingReasoningOpaque === undefined) {
    return false;
  }

  state.pendingThinkingSignature = (state.pendingThinkingSignature ?? '') + state.pendingReasoningOpaque;
  state.pendingReasoningOpaque = undefined;
  return true;
};

const emitPendingOpaqueReasoningBlock = (state: ChatCompletionsToMessagesStreamState, events: MessagesStreamEventData[]): void => {
  if (state.pendingReasoningOpaque === undefined) return;

  // Opaque data is attachable only to the currently open thinking block. Once a
  // thinking block has closed, later opaque-only reasoning must become its own
  // redacted_thinking block instead of being suppressed by global history.
  if (attachOpaqueToOpenThinkingBlock(state)) return;

  closeCurrentBlock(state, events);
  events.push(
    {
      type: 'content_block_start',
      index: state.contentBlockIndex,
      content_block: {
        type: 'redacted_thinking',
        data: state.pendingReasoningOpaque,
      },
    },
    { type: 'content_block_stop', index: state.contentBlockIndex },
  );
  state.contentBlockIndex++;
  state.pendingReasoningOpaque = undefined;
};

const emitContentDelta = (content: string, state: ChatCompletionsToMessagesStreamState, events: MessagesStreamEventData[]): void => {
  if (state.openBlock === 'tool_use') {
    closeCurrentBlock(state, events);
  }

  if (state.openBlock === undefined) {
    startContentBlock(state, events, 'text', { type: 'text', text: '' });
  }

  emitContentBlockDelta(state, events, {
    type: 'text_delta',
    text: content,
  });
};

const handleReasoningDelta = (delta: ChatStreamDelta, state: ChatCompletionsToMessagesStreamState, events: MessagesStreamEventData[]): boolean => {
  if (delta.reasoning_text) {
    if (state.openBlock !== 'thinking') {
      closeCurrentBlock(state, events);
      startContentBlock(state, events, 'thinking', {
        type: 'thinking',
        thinking: '',
      });
      attachOpaqueToOpenThinkingBlock(state);
    }

    emitContentBlockDelta(state, events, {
      type: 'thinking_delta',
      thinking: delta.reasoning_text,
    });
  }

  if (delta.reasoning_opaque === undefined || delta.reasoning_opaque === null) {
    return false;
  }

  if (state.openBlock === 'thinking') {
    state.pendingThinkingSignature = (state.pendingThinkingSignature ?? '') + delta.reasoning_opaque;
    return emitPendingReasoningAndDeferred(state, events);
  }

  state.pendingReasoningOpaque = (state.pendingReasoningOpaque ?? '') + delta.reasoning_opaque;
  return false;
};

const emitToolCallsDelta = (toolCalls: ChatStreamToolCalls, state: ChatCompletionsToMessagesStreamState, events: MessagesStreamEventData[]): boolean => {
  for (const toolCall of toolCalls) {
    if (toolCall.id && toolCall.function?.name) {
      closeCurrentBlock(state, events);
      const blockIndex = state.contentBlockIndex;
      state.toolCalls[toolCall.index] = {
        messagesBlockIndex: blockIndex,
        consecutiveWhitespace: 0,
      };
      startContentBlock(state, events, 'tool_use', {
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.function.name,
        input: {},
      });
    }

    if (!toolCall.function?.arguments) continue;

    const toolCallInfo = state.toolCalls[toolCall.index];
    if (!toolCallInfo) continue;

    const whitespace = checkWhitespaceOverflow(toolCall.function.arguments, toolCallInfo.consecutiveWhitespace);
    toolCallInfo.consecutiveWhitespace = whitespace.count;

    if (whitespace.exceeded) {
      console.warn('Infinite whitespace detected in tool call arguments, aborting stream');
      state.aborted = true;
      closeCurrentBlock(state, events);
      events.push({
        type: 'error',
        error: {
          type: 'api_error',
          message: 'Tool call arguments contained excessive whitespace, indicating a degenerate response.',
        },
      });
      return true;
    }

    emitContentBlockDelta(
      state,
      events,
      {
        type: 'input_json_delta',
        partial_json: toolCall.function.arguments,
      },
      toolCallInfo.messagesBlockIndex,
    );
  }

  return false;
};

const emitPendingReasoningAndDeferred = (state: ChatCompletionsToMessagesStreamState, events: MessagesStreamEventData[]): boolean => {
  // Opaque-only reasoning still owns source order: it may later become a
  // thinking signature, so content/tool deltas wait behind the reasoning gate.
  emitPendingOpaqueReasoningBlock(state, events);
  if (state.openBlock === 'thinking') {
    if (state.pendingThinkingSignature !== undefined) {
      emitContentBlockDelta(state, events, {
        type: 'signature_delta',
        signature: state.pendingThinkingSignature,
      });
      state.pendingThinkingSignature = undefined;
    }
    closeCurrentBlock(state, events);
  }

  const deferred = state.deferredAfterThinking;
  state.deferredAfterThinking = [];

  for (const item of deferred) {
    if (item.type === 'content') {
      emitContentDelta(item.content, state, events);
      continue;
    }

    if (emitToolCallsDelta(item.toolCalls, state, events)) return true;
  }

  return false;
};

const handleFinishReason = (
  finishReason: ChatCompletionChunk['choices'][0]['finish_reason'],
  chunk: ChatCompletionChunk,
  state: ChatCompletionsToMessagesStreamState,
  events: MessagesStreamEventData[],
): void => {
  if (emitPendingReasoningAndDeferred(state, events)) return;

  closeCurrentBlock(state, events);

  state.pendingFinishReason = finishReason;
  if (chunk.usage) state.pendingUsage = chunk.usage;
  if (chunk.usage) emitFinalMessageIfReady(state, events);
};

const emitFinalMessageIfReady = (state: ChatCompletionsToMessagesStreamState, events: MessagesStreamEventData[]): void => {
  if (!state.pendingFinishReason || state.finalMessageSent) return;

  const usage = mapChatCompletionsUsageToMessagesUsage(state.pendingUsage);

  events.push(
    {
      type: 'message_delta',
      delta: {
        stop_reason: mapChatCompletionsFinishReasonToMessagesStopReason(state.pendingFinishReason),
        stop_sequence: null,
      },
      usage,
    },
    { type: 'message_stop' },
  );

  state.finalMessageSent = true;
  state.pendingFinishReason = undefined;
};

export const createChatCompletionsToMessagesStreamState = (): ChatCompletionsToMessagesStreamState => ({
  messageStartSent: false,
  contentBlockIndex: 0,
  toolCalls: {},
  deferredAfterThinking: [],
});

export const translateChatCompletionsChunkToMessagesEvents = (chunk: ChatCompletionChunk, state: ChatCompletionsToMessagesStreamState): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];

  if (chunk.choices.length === 0) {
    if (!state.aborted && chunk.usage) {
      state.pendingUsage = chunk.usage;
      emitFinalMessageIfReady(state, events);
    }

    return events;
  }

  if (state.aborted) return events;

  // Chat Completions `n > 1` returns alternative completions, not parts of one
  // answer. Messages has no multi-candidate shape, so only the first choice
  // can be represented; choices[1+] are dropped.
  const choice = chunk.choices[0];

  if (!state.messageStartSent) {
    events.push({
      type: 'message_start',
      message: {
        id: toMessagesId(chunk.id),
        type: 'message',
        role: 'assistant',
        content: [],
        model: chunk.model,
        stop_reason: null,
        stop_sequence: null,
        usage: mapChatCompletionsUsageToMessagesUsage(chunk.usage),
      },
    });
    state.messageStartSent = true;
  }

  if (handleReasoningDelta(choice.delta, state, events)) return events;

  const content = choice.delta.content;
  if (content) {
    if (hasPendingReasoning(state)) {
      state.deferredAfterThinking.push({ type: 'content', content });
    } else {
      emitContentDelta(content, state, events);
    }
  }

  const toolCalls = choice.delta.tool_calls;
  if (toolCalls?.length) {
    if (hasPendingReasoning(state)) {
      state.deferredAfterThinking.push({ type: 'tool_calls', toolCalls });
    } else if (emitToolCallsDelta(toolCalls, state, events)) {
      return events;
    }
  }

  if (choice.finish_reason) {
    handleFinishReason(choice.finish_reason, chunk, state, events);
  }

  return events;
};

// Call once after the upstream Chat stream is exhausted. Some final Messages SSE
// events are intentionally buffered until end-of-stream so late usage and
// opaque-only reasoning can be emitted in valid block/message order.
export const flushChatCompletionsToMessagesEvents = (state: ChatCompletionsToMessagesStreamState): MessagesStreamEventData[] => {
  const events: MessagesStreamEventData[] = [];
  if (state.aborted) return events;
  if (emitPendingReasoningAndDeferred(state, events)) return events;
  closeCurrentBlock(state, events);
  emitFinalMessageIfReady(state, events);
  return events;
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> {
  const state = createChatCompletionsToMessagesStreamState();

  for await (const chunk of upstreamChatCompletionEventsUntilDone(frames)) {
    for (const event of translateChatCompletionsChunkToMessagesEvents(chunk, state)) {
      yield eventFrame(event);
    }
  }

  for (const event of flushChatCompletionsToMessagesEvents(state)) {
    yield eventFrame(event);
  }
};
