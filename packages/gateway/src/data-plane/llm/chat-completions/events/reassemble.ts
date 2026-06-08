import { chatCompletionsErrorPayloadMessage } from '@floway-dev/protocols/chat-completions';
import type { ChatCompletionsStreamEvent, ChatCompletionsResult, ChatCompletionsReasoningItem, ChatCompletionsChoiceNonStreaming, ChatCompletionsToolCall } from '@floway-dev/protocols/chat-completions';

export async function reassembleChatCompletionsEvents(chunks: AsyncIterable<ChatCompletionsStreamEvent>): Promise<ChatCompletionsResult> {
  let id = '';
  let model = '';
  let created = 0;
  let content = '';
  let reasoningText = '';
  let reasoningOpaque = '';
  let hasReasoningOpaque = false;
  const reasoningItems: ChatCompletionsReasoningItem[] = [];
  let finishReason: ChatCompletionsChoiceNonStreaming['finish_reason'] = 'stop';
  let lastUsage: ChatCompletionsResult['usage'] | undefined;

  const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();

  for await (const chunk of chunks) {
    const errorMessage = chatCompletionsErrorPayloadMessage(chunk);
    if (errorMessage) {
      throw new Error(`Upstream Chat Completions SSE error: ${errorMessage}`);
    }

    if (!id && chunk.id) {
      id = chunk.id as string;
      model = chunk.model as string;
      created = chunk.created as number;
    }

    if (chunk.usage) {
      lastUsage = chunk.usage as ChatCompletionsResult['usage'];
    }

    const choices = chunk.choices as unknown as Array<Record<string, unknown>> | undefined;
    if (!choices) continue;

    for (const choice of choices) {
      const delta = choice.delta as Record<string, unknown> | undefined;
      if (!delta) continue;

      if (typeof delta.content === 'string') {
        content += delta.content;
      }
      if (typeof delta.reasoning_text === 'string') {
        reasoningText += delta.reasoning_text;
      }
      if (typeof delta.reasoning_opaque === 'string') {
        reasoningOpaque += delta.reasoning_opaque;
        hasReasoningOpaque = true;
      }
      if (Array.isArray(delta.reasoning_items)) {
        reasoningItems.push(...(delta.reasoning_items as ChatCompletionsReasoningItem[]));
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const toolCall of delta.tool_calls as Array<Record<string, unknown>>) {
          const idx = toolCall.index as number;
          const existing = toolCallsMap.get(idx);
          if (!existing) {
            toolCallsMap.set(idx, {
              id: (toolCall.id as string) ?? '',
              name: ((toolCall.function as Record<string, unknown>)?.name as string) ?? '',
              arguments: ((toolCall.function as Record<string, unknown>)?.arguments as string) ?? '',
            });
          } else {
            if (toolCall.id) existing.id = toolCall.id as string;
            const fn = toolCall.function as Record<string, unknown> | undefined;
            if (fn?.name) existing.name = fn.name as string;
            if (fn?.arguments) {
              existing.arguments += fn.arguments as string;
            }
          }
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason as ChatCompletionsChoiceNonStreaming['finish_reason'];
      }
    }
  }

  const toolCalls: ChatCompletionsToolCall[] = [];
  const sortedIndices = [...toolCallsMap.keys()].sort((a, b) => a - b);
  for (const idx of sortedIndices) {
    const toolCall = toolCallsMap.get(idx)!;
    toolCalls.push({
      id: toolCall.id,
      type: 'function',
      function: { name: toolCall.name, arguments: toolCall.arguments },
    });
  }

  const message: ChatCompletionsChoiceNonStreaming['message'] = {
    role: 'assistant',
    content: content || null,
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
    ...(reasoningText && { reasoning_text: reasoningText }),
    ...(hasReasoningOpaque ? { reasoning_opaque: reasoningOpaque } : {}),
    ...(reasoningItems.length > 0 && { reasoning_items: reasoningItems }),
  };

  const result: ChatCompletionsResult = {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    ...(lastUsage && { usage: lastUsage }),
  };

  return result;
}
