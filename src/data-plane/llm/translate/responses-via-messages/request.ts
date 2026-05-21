import type { ModelCapabilities } from '../../../providers/capabilities.ts';
import {
  MESSAGES_FALLBACK_MAX_TOKENS,
  type MessagesAssistantContentBlock,
  type MessagesAssistantMessage,
  type MessagesMessage,
  type MessagesPayload,
  type MessagesTool,
  type MessagesToolResultBlock,
  type MessagesUserContentBlock,
  type MessagesUserMessage,
} from '../../../shared/protocol/messages.ts';
import type {
  ResponseFunctionTool,
  ResponseInputImage,
  ResponseInputItem,
  ResponseInputMessage,
  ResponseInputText,
  ResponsesPayload,
  ResponseTool,
  ResponseToolChoice,
} from '../../../shared/protocol/responses.ts';
import { responsesReasoningToMessagesBlock } from '../shared/messages-responses-signature.ts';
import { fetchRemoteImage, type RemoteImageLoader, resolveImageUrlToMessagesImage } from '../shared/remote-images.ts';
import { parseToolArgumentsObject } from '../shared/tool-arguments.ts';

interface TranslateResponsesToMessagesOptions {
  loadRemoteImage?: RemoteImageLoader;
  /**
   * Preferred cap used when the source payload omits `max_output_tokens`.
   * Callers in the data plane forward the model's advertised `/models` output
   * cap so the translated Messages request reflects the upstream-known limit
   * rather than being silently capped by a target-side default later.
   */
  fallbackMaxOutputTokens?: number;
}

const extractSystemText = (message: ResponseInputMessage): string => {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';

  // Assumption: OpenAI text parts are transport fragments of one message, not
  // paragraph-level blocks. Keep the existing no-separator join until we have
  // stronger evidence that Responses text parts carry harder boundaries.
  return message.content.map(block => ('text' in block ? block.text : '')).join('');
};

const translateUserMessage = async (message: ResponseInputMessage, loadRemoteImage: RemoteImageLoader): Promise<MessagesUserMessage> => {
  if (typeof message.content === 'string') {
    return { role: 'user', content: message.content };
  }

  const content: MessagesUserContentBlock[] = [];

  for (const block of message.content) {
    if (block.type === 'input_text') {
      content.push({ type: 'text', text: (block as ResponseInputText).text });
      continue;
    }

    if (block.type !== 'input_image') continue;

    const image = await resolveImageUrlToMessagesImage((block as ResponseInputImage).image_url, loadRemoteImage);
    if (image) content.push(image);
  }

  return { role: 'user', content: content.length > 0 ? content : '' };
};

const translateAssistantMessage = (message: ResponseInputMessage): MessagesAssistantMessage => {
  if (typeof message.content === 'string') {
    return { role: 'assistant', content: message.content };
  }

  const content: MessagesAssistantContentBlock[] = [];

  for (const block of message.content) {
    if (block.type === 'output_text') {
      content.push({ type: 'text', text: (block as ResponseInputText).text });
    }
  }

  return { role: 'assistant', content: content.length > 0 ? content : '' };
};

const appendAssistantBlock = (messages: MessagesMessage[], block: MessagesAssistantContentBlock): void => {
  const lastMessage = messages[messages.length - 1];

  if (lastMessage?.role === 'assistant' && Array.isArray(lastMessage.content)) {
    lastMessage.content.push(block);
    return;
  }

  messages.push({ role: 'assistant', content: [block] });
};

const appendUserBlock = (messages: MessagesMessage[], block: MessagesToolResultBlock): void => {
  const lastMessage = messages[messages.length - 1];

  if (lastMessage?.role === 'user' && Array.isArray(lastMessage.content)) {
    lastMessage.content.push(block);
    return;
  }

  messages.push({ role: 'user', content: [block] });
};

const translateResponsesInput = async (input: string | ResponseInputItem[], loadRemoteImage: RemoteImageLoader): Promise<{ messages: MessagesMessage[]; systemParts: string[] }> => {
  if (typeof input === 'string') {
    return {
      messages: [{ role: 'user', content: input }],
      systemParts: [],
    };
  }

  const messages: MessagesMessage[] = [];
  const systemParts: string[] = [];

  for (const item of input) {
    switch (item.type) {
    case 'message':
      if (item.role === 'system' || item.role === 'developer') {
        const text = extractSystemText(item);
        if (text) systemParts.push(text);
        continue;
      }

      messages.push(item.role === 'user' ? await translateUserMessage(item, loadRemoteImage) : translateAssistantMessage(item));
      break;
    case 'function_call':
      appendAssistantBlock(messages, {
        type: 'tool_use',
        id: item.call_id,
        name: item.name,
        input: parseToolArgumentsObject(item.arguments),
      });
      break;
    case 'function_call_output':
      appendUserBlock(messages, {
        type: 'tool_result',
        tool_use_id: item.call_id,
        content: item.output,
        is_error: item.status === 'incomplete' ? true : undefined,
      });
      break;
    case 'reasoning': {
      const block = responsesReasoningToMessagesBlock(item);
      if (block) appendAssistantBlock(messages, block);
      break;
    }
    }
  }

  return { messages, systemParts };
};

const translateTools = (tools?: ResponseTool[] | null): MessagesTool[] | undefined => {
  if (!tools || tools.length === 0) return undefined;

  // Hosted Responses tool entries (web_search, image_generation, …) and
  // Freeform `custom` tools do not carry the `name`/`parameters` pair Anthropic
  // Messages requires, and Anthropic upstream rejects them with
  // `tools.N.custom.name: Field required`. The source-level
  // strip-unsupported-tools interceptor drops every hosted entry, and
  // fix-apply-patch-tools rewrites Codex's `apply_patch` Freeform tool into a
  // function tool. Other Freeform tools currently have no shim, so they would
  // also reach this point as non-function entries — drop them defensively
  // rather than forwarding a malformed tool upstream.
  const functionTools = tools.filter((tool): tool is ResponseFunctionTool => tool.type === 'function');
  if (functionTools.length === 0) return undefined;

  return functionTools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
    strict: tool.strict,
  }));
};

const translateToolChoice = (toolChoice: ResponseToolChoice | undefined): MessagesPayload['tool_choice'] => {
  if (!toolChoice) return undefined;

  if (typeof toolChoice === 'string') {
    switch (toolChoice) {
    case 'auto':
      return { type: 'auto' };
    case 'none':
      return { type: 'none' };
    case 'required':
      return { type: 'any' };
    default:
      return undefined;
    }
  }

  return toolChoice.type === 'function' && toolChoice.name ? { type: 'tool', name: toolChoice.name } : undefined;
};

export const translateResponsesToMessages = async (payload: ResponsesPayload, options: TranslateResponsesToMessagesOptions = {}): Promise<MessagesPayload> => {
  const { messages, systemParts } = await translateResponsesInput(payload.input, options.loadRemoteImage ?? fetchRemoteImage);
  const system = [payload.instructions, ...systemParts].filter((part): part is string => Boolean(part)).join('\n\n');
  const effort = payload.reasoning?.effort;
  const maxTokens = payload.max_output_tokens ?? options.fallbackMaxOutputTokens ?? MESSAGES_FALLBACK_MAX_TOKENS;

  // Responses `metadata` is intentionally omitted on the Messages path instead
  // of being coerced into Anthropic `metadata.user_id`, prompt-cache, or safety
  // semantics.
  return {
    model: payload.model,
    messages,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    ...(payload.temperature != null ? { temperature: payload.temperature } : {}),
    ...(payload.top_p != null ? { top_p: payload.top_p } : {}),
    ...(payload.stream != null ? { stream: payload.stream } : {}),
    tools: translateTools(payload.tools),
    tool_choice: translateToolChoice(payload.tool_choice),
    ...(effort === 'none' ? { thinking: { type: 'disabled' as const } } : effort ? { output_config: { effort } } : {}),
  };
};

export const buildTargetRequest = (payload: ResponsesPayload, capabilities: ModelCapabilities): Promise<MessagesPayload> =>
  translateResponsesToMessages(payload, {
    fallbackMaxOutputTokens: capabilities.maxOutputTokens,
  });
