import type { ChatCompletionsPayload, Tool } from '../../../shared/protocol/chat-completions.ts';
import type { ResponseInputItem, ResponseInputReasoning, ResponsesPayload, ResponseTool, ResponseToolChoice } from '../../../shared/protocol/responses.ts';
import { chatContentToResponsesInputContent, chatContentToText } from '../shared/chat-responses-content.ts';
import { scalarToResponseReasoningItem, translateChatReasoningItems } from '../shared/chat-responses-reasoning.ts';
import { makeResponsesReasoningId } from '../shared/reasoning.ts';

const translateChatTools = (tools?: Tool[] | null): ResponseTool[] | null =>
  tools?.length
    ? tools.map(tool => ({
        type: 'function',
        name: tool.function.name,
        parameters: tool.function.parameters ?? { type: 'object', properties: {} },
        // Chat function tools are non-strict by default while Responses function
        // tools default strict; make omission explicit to preserve Chat semantics.
        strict: tool.function.strict ?? false,
        ...(tool.function.description ? { description: tool.function.description } : {}),
      }))
    : null;

const translateChatToolChoice = (choice?: ChatCompletionsPayload['tool_choice']): ResponseToolChoice =>
  choice == null ? 'auto' : typeof choice === 'string' ? choice : { type: 'function', name: choice.function.name };

export const translateChatCompletionsToResponses = (payload: ChatCompletionsPayload): ResponsesPayload => {
  const instructions: string[] = [];
  const input: ResponseInputItem[] = [];
  let hoistSystemPrefix = true;

  for (const message of payload.messages) {
    // Only the initial Chat `system` prefix maps cleanly to Responses
    // `instructions`; later `system` and `developer` turns are
    // chronology-bearing input items.
    if (hoistSystemPrefix && message.role === 'system') {
      const text = chatContentToText(message.content);
      if (text) instructions.push(text);
      continue;
    }

    hoistSystemPrefix = false;

    if (message.role === 'user') {
      input.push({
        type: 'message',
        role: 'user',
        content: chatContentToResponsesInputContent(message.content),
      });
      continue;
    }

    if (message.role === 'assistant') {
      const reasoningItems = translateChatReasoningItems<ResponseInputReasoning>(message.reasoning_items, () => input.length);
      const scalarReasoning = scalarToResponseReasoningItem<ResponseInputReasoning>(message.reasoning_text, message.reasoning_opaque, makeResponsesReasoningId(input.length));
      if (reasoningItems) {
        input.push(...reasoningItems);
      } else if (scalarReasoning) {
        input.push(scalarReasoning);
      }

      if (message.tool_calls?.length) {
        const text = chatContentToText(message.content);
        if (text) {
          input.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text }],
          });
        }

        for (const toolCall of message.tool_calls) {
          input.push({
            type: 'function_call',
            call_id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
            status: 'completed',
          });
        }

        continue;
      }

      const text = chatContentToText(message.content);
      input.push({
        type: 'message',
        role: 'assistant',
        content: text ? [{ type: 'output_text', text }] : '',
      });
      continue;
    }

    if (message.role === 'system' || message.role === 'developer') {
      input.push({
        type: 'message',
        role: message.role,
        content: chatContentToResponsesInputContent(message.content),
      });
      continue;
    }

    if (!message.tool_call_id) {
      throw new Error('tool message requires tool_call_id for Responses translation');
    }

    input.push({
      type: 'function_call_output',
      call_id: message.tool_call_id,
      output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    });
  }

  const responseTextConfig = payload.response_format === undefined ? undefined : payload.response_format === null ? null : { format: payload.response_format };

  return {
    model: payload.model,
    input,
    ...(instructions.length > 0 ? { instructions: instructions.join('\n\n') } : {}),
    ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
    ...(payload.top_p !== undefined ? { top_p: payload.top_p } : {}),
    ...(payload.max_tokens !== undefined ? { max_output_tokens: payload.max_tokens } : {}),
    ...(payload.tools !== undefined ? { tools: translateChatTools(payload.tools) } : {}),
    tool_choice: translateChatToolChoice(payload.tool_choice),
    // Same-purpose OpenAI fields are normal Chat/Responses adapter surface;
    // provider-specific policy filtering belongs at the target boundary, not in
    // pairwise translation.
    ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
    ...(payload.stream !== undefined ? { stream: payload.stream } : {}),
    // Preserve Chat's omitted `store` as omitted instead of synthesizing
    // `store: false`. OpenAI's migration guide treats storage as the default
    // behavior for both Responses and new Chat Completions accounts; callers
    // disable it explicitly with `store: false`.
    // Reference:
    // https://developers.openai.com/api/docs/guides/migrate-to-responses
    ...(payload.store !== undefined ? { store: payload.store } : {}),
    ...(payload.parallel_tool_calls !== undefined ? { parallel_tool_calls: payload.parallel_tool_calls } : {}),
    ...(payload.reasoning_effort != null ? { reasoning: { effort: payload.reasoning_effort } } : {}),
    ...(responseTextConfig !== undefined ? { text: responseTextConfig } : {}),
    ...(payload.prompt_cache_key !== undefined ? { prompt_cache_key: payload.prompt_cache_key } : {}),
    ...(payload.safety_identifier !== undefined ? { safety_identifier: payload.safety_identifier } : {}),
    ...(payload.service_tier !== undefined ? { service_tier: payload.service_tier } : {}),
    // Chat exposes opaque reasoning as scalar `reasoning_opaque`; ask Responses
    // for encrypted content so translated multi-turn Chat clients can round-trip
    // it without inventing a gateway-private state store.
    include: ['reasoning.encrypted_content'],
  };
};

export const buildTargetRequest = translateChatCompletionsToResponses;
