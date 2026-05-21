import { test } from "vitest";
// End-to-end validation of POST/PATCH /api/upstreams body validation
// around the enabled_fixes field: unknown ids hard-reject (400),
// known ids round-trip through serialization regardless of whether their
// appliesTo overlaps supported_endpoints.

import { assertEquals } from "../../test-assert.ts";
import { requestApp, setupAppTest } from "../../test-helpers.ts";

const upstreamCreateBody = (
  overrides: Record<string, unknown> = {},
) => ({
  name: "Test custom upstream",
  base_url: "https://example.com",
  bearer_token: "sk-test",
  supported_endpoints: ["/chat/completions"],
  enabled_fixes: [],
  ...overrides,
});

test("POST /api/upstreams rejects unknown enabled_fixes ids", async () => {
  const { adminKey } = await setupAppTest();

  const resp = await requestApp("/api/upstreams", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": adminKey,
    },
    body: JSON.stringify(upstreamCreateBody({
      enabled_fixes: ["totally-made-up-fix"],
    })),
  });

  assertEquals(resp.status, 400);
  const body = await resp.json() as { error?: string };
  assertEquals(
    body.error?.includes("totally-made-up-fix"),
    true,
    `expected error to mention the unknown id, got: ${body.error}`,
  );
});

test("POST /api/upstreams accepts known fixes regardless of supported_endpoints overlap", async () => {
  const { adminKey } = await setupAppTest();

  // deepseek-reasoning-dialect's appliesTo is chat_completions only, but
  // we don't reject fixes that wouldn't fire on this upstream — they're
  // inert at runtime because the assembler filters by registered fixIds
  // against the actually-served endpoints.
  const resp = await requestApp("/api/upstreams", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": adminKey,
    },
    body: JSON.stringify(upstreamCreateBody({
      supported_endpoints: ["/v1/messages"],
      enabled_fixes: ["deepseek-reasoning-dialect"],
    })),
  });

  assertEquals(resp.status, 201);
  const created = await resp.json() as Record<string, unknown>;
  assertEquals(created.enabled_fixes, ["deepseek-reasoning-dialect"]);
});

test("POST /api/upstreams accepts a valid enabled_fixes list and round-trips it", async () => {
  const { adminKey } = await setupAppTest();

  const create = await requestApp("/api/upstreams", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": adminKey,
    },
    body: JSON.stringify(upstreamCreateBody({
      enabled_fixes: ["deepseek-reasoning-dialect"],
    })),
  });

  assertEquals(create.status, 201);
  const created = await create.json() as Record<string, unknown>;
  assertEquals(created.enabled_fixes, ["deepseek-reasoning-dialect"]);

  // GET /api/upstreams should surface the same list.
  const list = await requestApp("/api/upstreams", {
    method: "GET",
    headers: { "x-api-key": adminKey },
  });
  assertEquals(list.status, 200);
  const items = await list.json() as Array<Record<string, unknown>>;
  const ours = items.find((u) => u.id === created.id);
  assertEquals(ours?.enabled_fixes, ["deepseek-reasoning-dialect"]);
});

test("GET /api/upstream-fixes returns the flag catalog", async () => {
  const { adminKey } = await setupAppTest();

  const resp = await requestApp("/api/upstream-fixes", {
    method: "GET",
    headers: { "x-api-key": adminKey },
  });

  assertEquals(resp.status, 200);
  const catalog = await resp.json() as Array<Record<string, unknown>>;
  const deepseek = catalog.find((e) => e.id === "deepseek-reasoning-dialect");
  assertEquals(deepseek?.appliesTo, ["chat_completions"]);
  assertEquals("defaultFor" in deepseek!, false);
});

test("GET /api/upstream-fixes requires admin auth", async () => {
  const { apiKey } = await setupAppTest();

  const resp = await requestApp("/api/upstream-fixes", {
    method: "GET",
    headers: { "x-api-key": apiKey.key },
  });

  assertEquals(resp.status, 403);
});
