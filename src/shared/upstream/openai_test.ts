import { test } from "vitest";
import { assertEquals } from "../../test-assert.ts";
import { createOpenAiUpstream } from "./openai.ts";
import type { UpstreamConfig } from "../../repo/types.ts";
import { withMockedFetch } from "../../test-helpers.ts";

const baseConfig: UpstreamConfig = {
  id: "up_test",
  name: "Test OpenAI",
  baseUrl: "https://oai.example.com",
  bearerToken: "sk-test",
  supportedEndpoints: ["/chat/completions"],
  enabled: true,
  sortOrder: 0,
  createdAt: "2026-04-29T00:00:00.000Z",
  enabledFixes: [],
};

test("createOpenAiUpstream uses default /v1/* paths", async () => {
  const upstream = createOpenAiUpstream(baseConfig);
  const seen: string[] = [];
  await withMockedFetch((request) => {
    seen.push(request.url);
    return new Response("{}", { status: 200 });
  }, async () => {
    await upstream.fetch("chat_completions", { method: "POST", body: "{}" });
    await upstream.fetch("responses", { method: "POST", body: "{}" });
    await upstream.fetch("messages", { method: "POST", body: "{}" });
    await upstream.fetch("messages_count_tokens", {
      method: "POST",
      body: "{}",
    });
    await upstream.fetch("embeddings", { method: "POST", body: "{}" });
    await upstream.fetch("models", { method: "GET" });
  });

  assertEquals(seen, [
    "https://oai.example.com/v1/chat/completions",
    "https://oai.example.com/v1/responses",
    "https://oai.example.com/v1/messages",
    "https://oai.example.com/v1/messages/count_tokens",
    "https://oai.example.com/v1/embeddings",
    "https://oai.example.com/v1/models",
  ]);
});

test("createOpenAiUpstream applies path overrides without an automatic /v1 prefix", async () => {
  const upstream = createOpenAiUpstream({
    ...baseConfig,
    pathOverrides: {
      messages: "/api/v1/messages",
      models: "/models",
    },
  });
  const seen: string[] = [];
  await withMockedFetch((request) => {
    seen.push(request.url);
    return new Response("{}", { status: 200 });
  }, async () => {
    await upstream.fetch("messages", { method: "POST", body: "{}" });
    await upstream.fetch("messages_count_tokens", {
      method: "POST",
      body: "{}",
    });
    await upstream.fetch("models", { method: "GET" });
    await upstream.fetch("chat_completions", { method: "POST", body: "{}" });
  });

  assertEquals(seen, [
    "https://oai.example.com/api/v1/messages",
    // count_tokens follows the messages override path.
    "https://oai.example.com/api/v1/messages/count_tokens",
    "https://oai.example.com/models",
    // Endpoints without an override fall back to the OpenAI default.
    "https://oai.example.com/v1/chat/completions",
  ]);
});

test("createOpenAiUpstream sends the configured bearer token", async () => {
  const upstream = createOpenAiUpstream(baseConfig);
  let authHeader: string | null = null;
  await withMockedFetch((request) => {
    authHeader = request.headers.get("authorization");
    return new Response("{}", { status: 200 });
  }, async () => {
    await upstream.fetch("models", { method: "GET" });
  });

  assertEquals(authHeader, "Bearer sk-test");
});

test("createOpenAiUpstream surfaces the configured enabled fixes as a Set", () => {
  const none = createOpenAiUpstream(baseConfig);
  const withFix = createOpenAiUpstream({
    ...baseConfig,
    enabledFixes: ["deepseek-reasoning-dialect"],
  });

  assertEquals(none.enabledFixes.size, 0);
  assertEquals(withFix.enabledFixes.has("deepseek-reasoning-dialect"), true);
});
