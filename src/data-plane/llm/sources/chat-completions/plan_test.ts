import { assertEquals } from "@std/assert";
import type { ModelCapabilities } from "../../shared/models/get-model-capabilities.ts";
import { planChatRequest } from "./plan.ts";

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

Deno.test("planChatRequest rejects explicit capability misses instead of legacy fallback", () => {
  const plan = planChatRequest(
    { model: "text-embedding-3-small", messages: [] },
    capabilities({ hasExplicitCapabilities: true }),
  );

  assertEquals(plan, null);
});

Deno.test("planChatRequest keeps legacy fallback when capabilities were not explicit", () => {
  const plan = planChatRequest(
    { model: "gpt-legacy-chat", messages: [] },
    capabilities(),
  );

  assertEquals(plan?.target, "chat-completions");
});
