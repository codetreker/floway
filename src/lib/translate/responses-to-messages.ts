import {
  MESSAGES_THINKING_PLACEHOLDER,
  type MessagesAssistantContentBlock,
  type MessagesAssistantMessage,
  type MessagesMessage,
  type MessagesPayload,
  type MessagesResponse,
  type MessagesTargetPayload,
  type MessagesTool,
  type MessagesToolResultBlock,
  type MessagesUserContentBlock,
  type MessagesUserMessage,
} from "../messages-types.ts";
import type {
  ResponseInputImage,
  ResponseInputItem,
  ResponseInputMessage,
  ResponseInputText,
  ResponseOutputContentBlock,
  ResponseOutputItem,
  ResponseFunctionTool,
  ResponsesPayload,
  ResponsesResult,
  ResponseTool,
  ResponseToolChoice,
} from "../responses-types.ts";
import {
  fetchRemoteImage,
  type RemoteImageLoader,
  resolveImageUrlToMessagesImage,
} from "./remote-images.ts";
import { safeJsonParse } from "./utils.ts";

interface TranslateResponsesToMessagesOptions {
  loadRemoteImage?: RemoteImageLoader;
}

const combineMessageTextContent = (
  content: ResponseOutputContentBlock[] | undefined,
): string => {
  if (!Array.isArray(content)) return "";

  // Compromise: our local Messages/Chat shapes have no dedicated refusal block,
  // so keep Responses refusal text visible rather than inventing extra
  // translated semantics at this boundary.
  return content.map((block) => {
    if (block.type === "output_text") return block.text;
    if (block.type === "refusal") return block.refusal;
    return "";
  }).join("");
};

const mapOutputToMessagesContent = (
  output: ResponseOutputItem[],
): MessagesAssistantContentBlock[] => {
  const content: MessagesAssistantContentBlock[] = [];

  for (const item of output) {
    switch (item.type) {
      case "reasoning": {
        // Keep `encrypted_content` as raw Anthropic opaque data. Another
        // Copilot gateway packs `encrypted_content@id` into `signature` to keep
        // Responses IDs cache-stable, but that mutates the Anthropic signature
        // surface; this gateway accepts possible Responses cache misses instead.
        // References:
        // - https://github.com/caozhiyuan/copilot-api/issues/63
        // - https://github.com/caozhiyuan/copilot-api/issues/73
        const thinking = item.summary?.length
          ? item.summary.map((part) => part.text).join("").trim()
          : "";

        if (!thinking && Object.hasOwn(item, "encrypted_content")) {
          content.push({
            type: "redacted_thinking",
            data: item.encrypted_content ?? "",
          });
          break;
        }

        const finalThinking = thinking || MESSAGES_THINKING_PLACEHOLDER;
        if (finalThinking.length === 0) break;

        content.push({
          type: "thinking",
          thinking: finalThinking,
          ...(Object.hasOwn(item, "encrypted_content")
            ? { signature: item.encrypted_content }
            : {}),
        });
        break;
      }
      case "function_call":
        if (item.name && item.call_id) {
          content.push({
            type: "tool_use",
            id: item.call_id,
            name: item.name,
            input: safeJsonParse(item.arguments),
          });
        }
        break;
      case "message": {
        const text = combineMessageTextContent(item.content);
        if (text.length > 0) content.push({ type: "text", text });
        break;
      }
    }
  }

  return content;
};

const mapResponsesStopReason = (
  response: ResponsesResult,
): MessagesResponse["stop_reason"] => {
  if (response.status === "completed") {
    return response.output.some((item) => item.type === "function_call")
      ? "tool_use"
      : "end_turn";
  }

  if (
    response.status === "incomplete" &&
    response.incomplete_details?.reason === "max_output_tokens"
  ) {
    return "max_tokens";
  }

  return null;
};

const extractSystemText = (
  message: ResponseInputMessage,
): string => {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";

  // Assumption: OpenAI text parts are transport fragments of one message, not
  // paragraph-level blocks. Keep the existing no-separator join until we have
  // stronger evidence that Responses text parts carry harder boundaries.
  return message.content.map((block) => "text" in block ? block.text : "").join(
    "",
  );
};

const translateUserMessage = async (
  message: ResponseInputMessage,
  loadRemoteImage: RemoteImageLoader,
): Promise<MessagesUserMessage> => {
  if (typeof message.content === "string") {
    return { role: "user", content: message.content };
  }

  const content: MessagesUserContentBlock[] = [];

  for (const block of message.content) {
    if (block.type === "input_text") {
      content.push({ type: "text", text: (block as ResponseInputText).text });
      continue;
    }

    if (block.type !== "input_image") continue;

    const image = await resolveImageUrlToMessagesImage(
      (block as ResponseInputImage).image_url,
      loadRemoteImage,
    );
    if (image) content.push(image);
  }

  return { role: "user", content: content.length > 0 ? content : "" };
};

const translateAssistantMessage = (
  message: ResponseInputMessage,
): MessagesAssistantMessage => {
  if (typeof message.content === "string") {
    return { role: "assistant", content: message.content };
  }

  const content: MessagesAssistantContentBlock[] = [];

  for (const block of message.content) {
    if (block.type === "output_text") {
      content.push({ type: "text", text: (block as ResponseInputText).text });
    }
  }

  return { role: "assistant", content: content.length > 0 ? content : "" };
};

const appendAssistantBlock = (
  messages: MessagesMessage[],
  block: MessagesAssistantContentBlock,
): void => {
  const lastMessage = messages[messages.length - 1];

  if (lastMessage?.role === "assistant" && Array.isArray(lastMessage.content)) {
    lastMessage.content.push(block);
    return;
  }

  messages.push({ role: "assistant", content: [block] });
};

const appendUserBlock = (
  messages: MessagesMessage[],
  block: MessagesToolResultBlock,
): void => {
  const lastMessage = messages[messages.length - 1];

  if (lastMessage?.role === "user" && Array.isArray(lastMessage.content)) {
    lastMessage.content.push(block);
    return;
  }

  messages.push({ role: "user", content: [block] });
};

const translateResponsesInput = async (
  input: string | ResponseInputItem[],
  loadRemoteImage: RemoteImageLoader,
): Promise<{ messages: MessagesMessage[]; systemParts: string[] }> => {
  if (typeof input === "string") {
    return {
      messages: [{ role: "user", content: input }],
      systemParts: [],
    };
  }

  const messages: MessagesMessage[] = [];
  const systemParts: string[] = [];

  for (const item of input) {
    switch (item.type) {
      case "message":
        if (item.role === "system" || item.role === "developer") {
          const text = extractSystemText(item);
          if (text) systemParts.push(text);
          continue;
        }

        messages.push(
          item.role === "user"
            ? await translateUserMessage(item, loadRemoteImage)
            : translateAssistantMessage(item),
        );
        break;
      case "function_call":
        appendAssistantBlock(messages, {
          type: "tool_use",
          id: item.call_id,
          name: item.name,
          input: safeJsonParse(item.arguments),
        });
        break;
      case "function_call_output":
        appendUserBlock(messages, {
          type: "tool_result",
          tool_use_id: item.call_id,
          content: item.output,
          is_error: item.status === "incomplete" ? true : undefined,
        });
        break;
      case "reasoning":
        appendAssistantBlock(
          messages,
          item.summary.length === 0 &&
            Object.hasOwn(item, "encrypted_content")
            ? {
              type: "redacted_thinking",
              data: item.encrypted_content ?? "",
            }
            : {
              type: "thinking",
              thinking: item.summary?.map((part) => part.text).join("") ||
                MESSAGES_THINKING_PLACEHOLDER,
              ...(Object.hasOwn(item, "encrypted_content")
                ? { signature: item.encrypted_content }
                : {}),
            },
        );
        break;
    }
  }

  return { messages, systemParts };
};

const translateTools = (
  tools?: ResponseTool[] | null,
): MessagesTool[] | undefined => {
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
  const functionTools = tools.filter(
    (tool): tool is ResponseFunctionTool => tool.type === "function",
  );
  if (functionTools.length === 0) return undefined;

  return functionTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
    strict: tool.strict,
  }));
};

const translateToolChoice = (
  toolChoice: ResponseToolChoice | undefined,
): MessagesPayload["tool_choice"] => {
  if (!toolChoice) return undefined;

  if (typeof toolChoice === "string") {
    switch (toolChoice) {
      case "auto":
        return { type: "auto" };
      case "none":
        return { type: "none" };
      case "required":
        return { type: "any" };
      default:
        return undefined;
    }
  }

  return toolChoice.type === "function" && toolChoice.name
    ? { type: "tool", name: toolChoice.name }
    : undefined;
};

export const translateResponsesToMessagesResponse = (
  response: ResponsesResult,
): MessagesResponse => {
  const content = mapOutputToMessagesContent(response.output);
  const finalContent = content.length > 0
    ? content
    : response.output_text
    ? [{ type: "text" as const, text: response.output_text }]
    : [];

  const inputTokens = response.usage?.input_tokens ?? 0;
  const cachedTokens = response.usage?.input_tokens_details?.cached_tokens;

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    content: finalContent,
    model: response.model,
    stop_reason: mapResponsesStopReason(response),
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens - (cachedTokens ?? 0),
      output_tokens: response.usage?.output_tokens ?? 0,
      ...(cachedTokens !== undefined
        ? { cache_read_input_tokens: cachedTokens }
        : {}),
    },
  };
};

export const translateResponsesToMessages = async (
  payload: ResponsesPayload,
  options: TranslateResponsesToMessagesOptions = {},
): Promise<MessagesTargetPayload> => {
  const { messages, systemParts } = await translateResponsesInput(
    payload.input,
    options.loadRemoteImage ?? fetchRemoteImage,
  );
  const system = [payload.instructions, ...systemParts].filter((
    part,
  ): part is string => Boolean(part)).join("\n\n");
  const effort = payload.reasoning?.effort;

  // Responses `metadata` is intentionally omitted on the Messages path instead
  // of being coerced into Anthropic `metadata.user_id`, prompt-cache, or safety
  // semantics.
  return {
    model: payload.model,
    messages,
    ...(payload.max_output_tokens != null
      ? { max_tokens: payload.max_output_tokens }
      : {}),
    ...(system ? { system } : {}),
    ...(payload.temperature != null
      ? { temperature: payload.temperature }
      : {}),
    ...(payload.top_p != null ? { top_p: payload.top_p } : {}),
    ...(payload.stream != null ? { stream: payload.stream } : {}),
    tools: translateTools(payload.tools),
    tool_choice: translateToolChoice(payload.tool_choice),
    ...(effort === "none"
      ? { thinking: { type: "disabled" as const } }
      : effort
      ? { output_config: { effort } }
      : {}),
  };
};
