import type { ChatCompletionResponse } from '../../../shared/protocol/chat-completions.ts';
import type { ResponseOutputFunctionCall, ResponseOutputItem, ResponseOutputMessage, ResponseOutputReasoning, ResponsesResult } from '../../../shared/protocol/responses.ts';
import { scalarToResponseReasoningItem, translateChatReasoningItems } from '../shared/chat-responses-reasoning.ts';
import { makeResponsesReasoningId } from '../shared/reasoning.ts';

export const mapChatCompletionsUsageToResponsesUsage = (usage: ChatCompletionResponse['usage'] | undefined): ResponsesResult['usage'] | undefined =>
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

const mapResultStatus = (finishReason: ChatCompletionResponse['choices'][0]['finish_reason']): ResponsesResult['status'] => (finishReason === 'length' ? 'incomplete' : 'completed');

export const translateChatCompletionToResponsesResult = (response: ChatCompletionResponse): ResponsesResult => {
  const choice = response.choices[0];
  const output: ResponseOutputItem[] = [];
  const reasoningText = choice.message.reasoning_text;
  const reasoningOpaque = choice.message.reasoning_opaque;

  const reasoningItems = translateChatReasoningItems<ResponseOutputReasoning>(choice.message.reasoning_items, () => output.length);
  const scalarReasoning = scalarToResponseReasoningItem<ResponseOutputReasoning>(reasoningText, reasoningOpaque, makeResponsesReasoningId(output.length));
  if (reasoningItems) {
    output.push(...reasoningItems);
  } else if (scalarReasoning) {
    output.push(scalarReasoning);
  }

  if (choice.message.content) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: choice.message.content }],
    } satisfies ResponseOutputMessage);
  }

  for (const toolCall of choice.message.tool_calls ?? []) {
    output.push({
      type: 'function_call',
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
      status: 'completed',
    } satisfies ResponseOutputFunctionCall);
  }

  return {
    id: response.id,
    object: 'response',
    model: response.model,
    output,
    output_text: choice.message.content ?? '',
    status: mapResultStatus(choice.finish_reason),
    ...(choice.finish_reason === 'length' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    usage: mapChatCompletionsUsageToResponsesUsage(response.usage),
  };
};
