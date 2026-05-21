import type { ChatCompletionResponse, ToolCall } from '../../../shared/protocol/chat-completions.ts';
import type { ResponsesResult } from '../../../shared/protocol/responses.ts';
import { addResponseReasoningToChatProjection, chatReasoningProjectionFields, createChatReasoningProjection } from '../shared/chat-responses-reasoning.ts';

export const mapResponsesFinishReasonToChatCompletionsFinishReason = (response: ResponsesResult): ChatCompletionResponse['choices'][0]['finish_reason'] =>
  response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens'
    ? 'length'
    : response.status === 'completed' && response.output.some(item => item.type === 'function_call')
      ? 'tool_calls'
      : 'stop';

export const translateResponsesToChatCompletion = (response: ResponsesResult): ChatCompletionResponse => {
  let content = '';
  const toolCalls: ToolCall[] = [];
  const reasoning = createChatReasoningProjection();

  // Preserve every reasoning item, and expose only the first scalar group through
  // legacy `reasoning_text` / `reasoning_opaque` fields.
  for (const item of response.output) {
    if (item.type === 'message') {
      for (const block of item.content) {
        if (block.type === 'output_text') {
          content += block.text;
          continue;
        }

        // Compromise: our local Chat shape has no dedicated refusal field, so
        // keep refusal text visible rather than inventing extra translated
        // semantics at this boundary.
        content += block.refusal;
      }
      continue;
    }

    if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      });
      continue;
    }

    addResponseReasoningToChatProjection(reasoning, item);
  }

  if (!content && response.output_text) {
    content = response.output_text;
  }

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const cachedTokens = response.usage?.input_tokens_details?.cached_tokens;

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
          content: content || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          ...chatReasoningProjectionFields(reasoning),
        },
        finish_reason: mapResponsesFinishReasonToChatCompletionsFinishReason(response),
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      ...(cachedTokens !== undefined ? { prompt_tokens_details: { cached_tokens: cachedTokens } } : {}),
    },
  };
};
