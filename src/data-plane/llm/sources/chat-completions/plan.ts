import type { ChatCompletionsPayload } from "../../shared/protocol/chat-completions.ts";
import type { ModelCapabilities } from "../../shared/models/get-model-capabilities.ts";
import type { CopilotFetchOptions } from "../../../../shared/copilot.ts";

export type ChatPlan =
  | { target: "messages"; fetchOptions: CopilotFetchOptions }
  | { target: "responses"; fetchOptions: CopilotFetchOptions }
  | { target: "chat-completions"; fetchOptions: CopilotFetchOptions };

const hasVision = (payload: ChatCompletionsPayload): boolean =>
  payload.messages.some((message) =>
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === "image_url")
  );

export const planChatRequest = (
  payload: ChatCompletionsPayload,
  capabilities: ModelCapabilities,
): ChatPlan | null => {
  const fetchOptions = { vision: hasVision(payload) };

  // Chat-origin routing intentionally prefers Messages when the model supports
  // it, because that path preserves more Anthropic structure than native Chat.
  if (capabilities.supportsMessages) {
    return {
      target: "messages",
      fetchOptions,
    };
  }

  if (capabilities.supportsChatCompletions) {
    return {
      target: "chat-completions",
      fetchOptions,
    };
  }

  if (capabilities.supportsResponses) {
    return {
      target: "responses",
      fetchOptions,
    };
  }

  if (capabilities.hasExplicitCapabilities) return null;

  // Capability misses keep the legacy model-name heuristic so old callers still
  // get the same Claude -> Messages and non-Claude -> Chat routing behavior.
  return payload.model.startsWith("claude")
    ? {
      target: "messages",
      fetchOptions,
    }
    : {
      target: "chat-completions",
      fetchOptions,
    };
};
