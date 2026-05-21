import { test } from "vitest";
import { assertEquals } from "../../../../test-assert.ts";
import type { ModelCapabilities } from "../../../providers/capabilities.ts";
import { planChatRequest } from "./plan.ts";

const capabilities = (
  overrides: Partial<ModelCapabilities> = {},
): ModelCapabilities => ({
  supportedEndpoints: [],
  supportsMessages: false,
  supportsResponses: false,
  supportsChatCompletions: false,
  supportsAdaptiveThinking: false,
  ...overrides,
});

test("planChatRequest rejects capability misses instead of legacy fallback", () => {
  const plan = planChatRequest(capabilities());

  assertEquals(plan, null);
});

test("planChatRequest prefers native Chat when both Chat and Messages are available", () => {
  const plan = planChatRequest(
    capabilities({
      supportedEndpoints: ["messages", "chat_completions"],
      supportsMessages: true,
      supportsChatCompletions: true,
    }),
  );

  assertEquals(plan?.target, "chat-completions");
});

test("planChatRequest does not invent legacy fallback without provider endpoints", () => {
  const plan = planChatRequest(capabilities());

  assertEquals(plan, null);
});
