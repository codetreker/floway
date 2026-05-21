import { test } from "vitest";
import { assertEquals } from "../../test-assert.ts";
import { upstreamConfigToFullJson, upstreamConfigToJson } from "./serialize.ts";
import type { UpstreamConfig } from "../../repo/types.ts";

const sampleConfig: UpstreamConfig = {
  id: "up_test123",
  name: "Test Upstream",
  baseUrl: "https://api.example.com",
  bearerToken: "sk-secret-token-12345",
  supportedEndpoints: ["/chat/completions", "/responses"],
  enabled: true,
  sortOrder: 10,
  createdAt: "2026-04-29T00:00:00.000Z",
  enabledFixes: [],
};

test("upstreamConfigToJson omits bearer token and includes bearer_token_set", () => {
  const result = upstreamConfigToJson(sampleConfig) as Record<string, unknown>;

  assertEquals(result.id, "up_test123");
  assertEquals(result.name, "Test Upstream");
  assertEquals(result.base_url, "https://api.example.com");
  assertEquals(result.bearer_token_set, true);
  assertEquals(result.bearer_token, undefined);
  assertEquals(result.supported_endpoints, ["/chat/completions", "/responses"]);
  assertEquals(result.enabled, true);
  assertEquals(result.sort_order, 10);
  assertEquals(result.created_at, "2026-04-29T00:00:00.000Z");
  assertEquals(result.enabled_fixes, []);
  assertEquals(result.path_overrides, undefined);
});

test("upstreamConfigToJson reports bearer_token_set as false for empty token", () => {
  const result = upstreamConfigToJson({
    ...sampleConfig,
    bearerToken: "",
  });

  assertEquals(result.bearer_token_set, false);
});

test("upstreamConfigToJson surfaces enabled_fixes and path_overrides when set", () => {
  const result = upstreamConfigToJson({
    ...sampleConfig,
    enabledFixes: ["deepseek-reasoning-dialect"],
    pathOverrides: { messages: "/api/v1/messages" },
  }) as Record<string, unknown>;

  assertEquals(result.enabled_fixes, ["deepseek-reasoning-dialect"]);
  assertEquals(result.path_overrides, { messages: "/api/v1/messages" });
});

test("upstreamConfigToFullJson includes bearer token", () => {
  const result = upstreamConfigToFullJson(sampleConfig) as Record<
    string,
    unknown
  >;

  assertEquals(result.id, "up_test123");
  assertEquals(result.bearer_token, "sk-secret-token-12345");
  assertEquals(result.bearer_token_set, undefined);
  assertEquals(result.enabled_fixes, []);
});
