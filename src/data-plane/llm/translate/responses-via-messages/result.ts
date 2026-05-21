import type { MessagesResponse } from '../../../shared/protocol/messages.ts';
import type { ResponseOutputFunctionCall, ResponseOutputItem, ResponseOutputMessage, ResponseOutputReasoning, ResponsesResult } from '../../../shared/protocol/responses.ts';
import { unpackReasoningSignature } from '../shared/messages-responses-signature.ts';
import { makeResponsesReasoningId } from '../shared/reasoning.ts';

const mapMessagesStatusToResponsesStatus = (response: MessagesResponse): ResponsesResult['status'] => (response.stop_reason === 'max_tokens' ? 'incomplete' : 'completed');

export const translateMessagesToResponsesResult = (response: MessagesResponse): ResponsesResult => {
  const output: ResponseOutputItem[] = [];
  let outputText = '';

  // Responses `output[]` can express ordered mixed reasoning/text/tool items, so
  // the non-stream result follows source block order instead of merging all text
  // into one trailing assistant message.
  for (const block of response.content) {
    switch (block.type) {
    case 'thinking': {
      // Same pack/unpack rationale as the request-side path above; see
      // `../shared/messages-responses-signature.ts`.
      const unpacked = typeof block.signature === 'string' ? unpackReasoningSignature(block.signature) : null;
      output.push({
        type: 'reasoning',
        id: unpacked?.id ?? makeResponsesReasoningId(output.length),
        summary: block.thinking ? [{ type: 'summary_text', text: block.thinking }] : [],
        ...(unpacked ? { encrypted_content: unpacked.encryptedContent } : {}),
      } as ResponseOutputReasoning);
      break;
    }
    case 'redacted_thinking': {
      const unpacked = unpackReasoningSignature(block.data);
      output.push({
        type: 'reasoning',
        id: unpacked.id ?? makeResponsesReasoningId(output.length),
        summary: [],
        encrypted_content: unpacked.encryptedContent,
      } as ResponseOutputReasoning);
      break;
    }
    case 'text':
      outputText += block.text;
      output.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: block.text }],
      } as ResponseOutputMessage);
      break;
    case 'tool_use':
      output.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
        status: 'completed',
      } as ResponseOutputFunctionCall);
      break;
    case 'server_tool_use':
    case 'web_search_tool_result':
      break;
    }
  }

  const inputTokens = response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);

  return {
    id: response.id,
    object: 'response',
    model: response.model,
    output,
    output_text: outputText,
    status: mapMessagesStatusToResponsesStatus(response),
    ...(response.stop_reason === 'max_tokens' ? { incomplete_details: { reason: 'max_output_tokens' as const } } : {}),
    usage: {
      input_tokens: inputTokens,
      output_tokens: response.usage.output_tokens,
      total_tokens: inputTokens + response.usage.output_tokens,
      ...(response.usage.cache_read_input_tokens !== undefined
        ? {
            input_tokens_details: {
              cached_tokens: response.usage.cache_read_input_tokens,
            },
          }
        : {}),
    },
  };
};
