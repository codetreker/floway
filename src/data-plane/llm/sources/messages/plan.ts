import type { MessagesPayload } from "../../shared/protocol/messages.ts";
import type { ModelCapabilities } from "../../shared/models/get-model-capabilities.ts";
import type { CopilotFetchOptions } from "../../../../shared/copilot.ts";

export type MessagesPlan =
  | {
    target: "messages";
    fetchOptions: CopilotFetchOptions;
    rawBeta?: string;
  }
  | { target: "responses"; fetchOptions: CopilotFetchOptions }
  | { target: "chat-completions"; fetchOptions: CopilotFetchOptions };

const hasVision = (payload: MessagesPayload): boolean =>
  payload.messages.some((message) =>
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === "image")
  );

const getInitiator = (payload: MessagesPayload): "user" | "agent" => {
  const lastMessage = payload.messages[payload.messages.length - 1];
  if (!lastMessage || lastMessage.role !== "user") return "agent";
  if (!Array.isArray(lastMessage.content)) return "user";

  return lastMessage.content.some((block) => block.type !== "tool_result")
    ? "user"
    : "agent";
};

export const planMessagesRequest = (
  payload: MessagesPayload,
  capabilities: ModelCapabilities,
  rawBeta: string | undefined,
): MessagesPlan | null => {
  const fetchOptions = {
    vision: hasVision(payload),
    initiator: getInitiator(payload),
  };

  // Messages-origin routing prefers native Messages, then Responses, and only
  // uses Chat Completions as the last fallback.
  if (capabilities.supportsMessages) {
    return {
      target: "messages",
      fetchOptions,
      rawBeta,
    };
  }

  if (capabilities.supportsResponses) {
    return {
      target: "responses",
      fetchOptions,
    };
  }

  if (capabilities.supportsChatCompletions) {
    return {
      target: "chat-completions",
      fetchOptions,
    };
  }

  if (capabilities.hasExplicitCapabilities) return null;

  return {
    target: "chat-completions",
    fetchOptions,
  };
};
