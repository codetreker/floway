import { assertEquals } from "@std/assert";
import type { ModelCapabilities } from "../../shared/models/get-model-capabilities.ts";
import { planMessagesRequest } from "./plan.ts";

const capabilities = (
  overrides: Partial<ModelCapabilities> = {},
): ModelCapabilities => ({
  supportsMessages: false,
  supportsResponses: false,
  supportsChatCompletions: false,
  supportsAdaptiveThinking: false,
  hasExplicitCapabilities: false,
  ...overrides,
});

Deno.test("planMessagesRequest rejects explicit capability misses instead of chat fallback", () => {
  const plan = planMessagesRequest(
    {
      model: "text-embedding-3-small",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
    },
    capabilities({ hasExplicitCapabilities: true }),
    undefined,
  );

  assertEquals(plan, null);
});

Deno.test("planMessagesRequest honors explicit Chat Completions support", () => {
  const plan = planMessagesRequest(
    {
      model: "gpt-chat-only",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
    },
    capabilities({
      supportsChatCompletions: true,
      hasExplicitCapabilities: true,
    }),
    undefined,
  );

  assertEquals(plan?.target, "chat-completions");
});

Deno.test("planMessagesRequest keeps legacy chat fallback when capabilities were not explicit", () => {
  const plan = planMessagesRequest(
    {
      model: "gpt-legacy-chat",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
    },
    capabilities(),
    undefined,
  );

  assertEquals(plan?.target, "chat-completions");
});
