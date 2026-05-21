import type { ChatCompletionResponse } from '../../../shared/protocol/chat-completions.ts';
import type { MessagesRedactedThinkingBlock, MessagesResponse, MessagesTextBlock, MessagesThinkingBlock, MessagesToolUseBlock } from '../../../shared/protocol/messages.ts';
import { messagesThinkingBlockFromChatScalarReasoning } from '../shared/messages-chat-reasoning.ts';
import { parseToolArgumentsObject } from '../shared/tool-arguments.ts';

export const toMessagesId = (id: string): string => (id.startsWith('msg_') ? id : `msg_${id.replace(/^chatcmpl-/, '')}`);

export const mapChatCompletionsFinishReasonToMessagesStopReason = (finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null): MessagesResponse['stop_reason'] => {
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

export const translateChatCompletionsToMessagesResponse = (response: ChatCompletionResponse): MessagesResponse => {
  const thinkingBlocks: Array<MessagesThinkingBlock | MessagesRedactedThinkingBlock> = [];
  const textBlocks: MessagesTextBlock[] = [];
  const toolUseBlocks: MessagesToolUseBlock[] = [];
  let stopReason = response.choices[0]?.finish_reason ?? null;

  for (const choice of response.choices) {
    const thinkingBlock = messagesThinkingBlockFromChatScalarReasoning(choice.message.reasoning_text, choice.message.reasoning_opaque);
    if (thinkingBlock) thinkingBlocks.push(thinkingBlock);

    if (choice.message.content) {
      textBlocks.push({ type: 'text', text: choice.message.content });
    }

    for (const toolCall of choice.message.tool_calls ?? []) {
      toolUseBlocks.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.function.name,
        input: parseToolArgumentsObject(toolCall.function.arguments),
      });
    }

    if (choice.finish_reason === 'tool_calls' || stopReason === 'stop') {
      stopReason = choice.finish_reason;
    }
  }

  return {
    id: toMessagesId(response.id),
    type: 'message',
    role: 'assistant',
    model: response.model,
    content: [...thinkingBlocks, ...textBlocks, ...toolUseBlocks],
    stop_reason: mapChatCompletionsFinishReasonToMessagesStopReason(stopReason),
    stop_sequence: null,
    usage: mapChatCompletionsUsageToMessagesUsage(response.usage),
  };
};
