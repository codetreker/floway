import { assertEquals } from "@std/assert";
import type { ModelCapabilities } from "../../shared/models/get-model-capabilities.ts";
import { planGeminiRequest } from "./plan.ts";

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

Deno.test("planGeminiRequest rejects explicit capability misses instead of legacy fallback", () => {
  const plan = planGeminiRequest(
    { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
    "text-embedding-3-small",
    capabilities({ hasExplicitCapabilities: true }),
  );

  assertEquals(plan, null);
});

Deno.test("planGeminiRequest keeps legacy fallback when capabilities were not explicit", () => {
  const plan = planGeminiRequest(
    { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
    "gpt-legacy-chat",
    capabilities(),
  );

  assertEquals(plan?.target, "chat-completions");
});
