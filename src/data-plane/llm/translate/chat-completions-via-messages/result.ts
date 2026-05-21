import type { ChatCompletionResponse, ToolCall } from '../../../shared/protocol/chat-completions.ts';
import type { MessagesResponse } from '../../../shared/protocol/messages.ts';
import { type ChatScalarReasoning, chatScalarReasoningFromMessagesBlock } from '../shared/messages-chat-reasoning.ts';

export const mapMessagesStopReasonToChatCompletionsFinishReason = (stopReason: MessagesResponse['stop_reason']): ChatCompletionResponse['choices'][0]['finish_reason'] => {
  switch (stopReason) {
  case null:
  case 'end_turn':
  case 'stop_sequence':
  case 'pause_turn':
  case 'refusal':
    return 'stop';
  case 'max_tokens':
    return 'length';
  case 'tool_use':
    return 'tool_calls';
  }
};

export const translateMessagesToChatCompletionsResponse = (response: MessagesResponse): ChatCompletionResponse => {
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  let scalarReasoning: ChatScalarReasoning | null = null;

  for (const block of response.content) {
    switch (block.type) {
    case 'text':
      textParts.push(block.text);
      break;
    case 'tool_use':
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
      break;
    case 'thinking':
    case 'redacted_thinking':
      scalarReasoning ??= chatScalarReasoningFromMessagesBlock(block);
      break;
    case 'server_tool_use':
    case 'web_search_tool_result':
      break;
    }
  }

  const promptTokens = response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
  const completionTokens = response.usage.output_tokens;

  return {
    id: response.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: textParts.join('') || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          ...(scalarReasoning?.reasoningText ? { reasoning_text: scalarReasoning.reasoningText } : {}),
          ...(scalarReasoning?.hasReasoningOpaque ? { reasoning_opaque: scalarReasoning.reasoningOpaque } : {}),
        },
        finish_reason: mapMessagesStopReasonToChatCompletionsFinishReason(response.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      ...(response.usage.cache_read_input_tokens != null
        ? {
            prompt_tokens_details: {
              cached_tokens: response.usage.cache_read_input_tokens,
            },
          }
        : {}),
    },
  };
};
