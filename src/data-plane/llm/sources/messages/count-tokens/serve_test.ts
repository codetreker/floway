import { test } from "vitest";
import { assertEquals } from "../../../../../test-assert.ts";
import { clearCopilotTokenCache } from "../../../../../shared/copilot.ts";
import { clearModelsCache } from "../../../../providers/upstream-model-cache.ts";
import {
  copilotModels,
  jsonResponse,
  requestApp,
  setupAppTest,
  withMockedFetch,
} from "../../../../../test-helpers.ts";

function copilotTokenResponse() {
  return jsonResponse({
    token: "fake-copilot-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_in: 1800,
  });
}

test("/v1/messages/count_tokens proxies to Copilot upstream", async () => {
  const { apiKey } = await setupAppTest();
  let capturedPath = "";

  await withMockedFetch((req) => {
    const url = new URL(req.url);
    if (url.hostname === "api.github.com") return copilotTokenResponse();
    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        { id: "claude-sonnet-4", supported_endpoints: ["/v1/messages"] },
      ]));
    }
    capturedPath = url.pathname;
    return jsonResponse({ input_tokens: 42 });
  }, async () => {
    const response = await requestApp("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assertEquals(response.status, 200);
    assertEquals(await response.json(), { input_tokens: 42 });
    assertEquals(capturedPath, "/v1/messages/count_tokens");
  });
});

test("/v1/messages/count_tokens rejects body anthropic_beta", async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp("/v1/messages/count_tokens", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey.key,
    },
    body: JSON.stringify({
      model: "claude-sonnet-4",
      max_tokens: 64,
      anthropic_beta: ["context-1m-2025-08-07"],
      messages: [{ role: "user", content: "hello" }],
    }),
  });

  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.error.type, "invalid_request_error");
  assertEquals(body.error.param, "anthropic_beta");
});

test("/v1/messages/count_tokens rejects body betas", async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp("/v1/messages/count_tokens", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey.key,
    },
    body: JSON.stringify({
      model: "claude-sonnet-4",
      max_tokens: 64,
      betas: ["context-1m-2025-08-07"],
      messages: [{ role: "user", content: "hello" }],
    }),
  });

  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.error.type, "invalid_request_error");
  assertEquals(body.error.param, "betas");
});

test("/messages/count_tokens aliases /v1/messages/count_tokens", async () => {
  const { apiKey } = await setupAppTest();
  let capturedPath = "";

  await withMockedFetch((req) => {
    const url = new URL(req.url);
    if (url.hostname === "api.github.com") return copilotTokenResponse();
    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        { id: "claude-sonnet-4", supported_endpoints: ["/v1/messages"] },
      ]));
    }
    capturedPath = url.pathname;
    return jsonResponse({ input_tokens: 24 });
  }, async () => {
    const response = await requestApp("/messages/count_tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assertEquals(response.status, 200);
    assertEquals(await response.json(), { input_tokens: 24 });
    assertEquals(capturedPath, "/v1/messages/count_tokens");
  });
});

test("/v1/messages/count_tokens resolves Claude compatibility models before proxying", async () => {
  const { apiKey } = await setupAppTest();
  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(async (req) => {
    const url = new URL(req.url);
    if (url.hostname === "api.github.com") return copilotTokenResponse();
    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        { id: "claude-opus-4.7", supported_endpoints: ["/v1/messages"] },
        {
          id: "claude-opus-4.7-1m-internal",
          supported_endpoints: ["/v1/messages"],
          maxContextWindowTokens: 1_000_000,
          maxPromptTokens: 936_000,
          maxOutputTokens: 64_000,
        },
      ]));
    }
    if (url.pathname === "/v1/messages/count_tokens") {
      upstreamBody = JSON.parse(await req.text()) as Record<string, unknown>;
      return jsonResponse({ input_tokens: 64 });
    }
    throw new Error(`Unhandled fetch ${req.url}`);
  }, async () => {
    const response = await requestApp("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
        "anthropic-beta": "context-1m-2025-08-07",
      },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assertEquals(response.status, 200);
    assertEquals(await response.json(), { input_tokens: 64 });
  });

  assertEquals(upstreamBody?.model, "claude-opus-4.7-1m-internal");
});

test("/v1/messages/count_tokens rejects custom-upstream-only models", async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.github.deleteAllAccounts();
  clearModelsCache();
  await clearCopilotTokenCache();

  await repo.upstreamConfigs.save({
    id: "up_custom",
    name: "Custom Provider",
    baseUrl: "https://custom.example.com",
    bearerToken: "sk-custom",
    supportedEndpoints: ["/chat/completions"],
    enabled: true,
    sortOrder: 100,
    createdAt: "2026-05-01T00:00:00.000Z",
    enabledFixes: [],
  });

  await withMockedFetch((request) => {
    const url = new URL(request.url);

    if (
      url.hostname === "custom.example.com" &&
      url.pathname === "/v1/models"
    ) {
      return jsonResponse({
        object: "list",
        data: [{ id: "custom-chat-model" }],
      });
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "custom-chat-model",
        max_tokens: 100,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assertEquals(response.status, 400);
    const body = await response.json();
    assertEquals(body.error.type, "invalid_request_error");
    assertEquals(
      body.error.message.includes(
        "does not support the /messages/count_tokens endpoint",
      ),
      true,
    );
  });
});

test("/v1/messages/count_tokens preserves custom upstream /models HTTP errors", async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.github.deleteAllAccounts();
  clearModelsCache();
  await clearCopilotTokenCache();

  await repo.upstreamConfigs.save({
    id: "up_custom",
    name: "Custom Provider",
    baseUrl: "https://custom.example.com",
    bearerToken: "sk-custom",
    supportedEndpoints: ["/chat/completions"],
    enabled: true,
    sortOrder: 100,
    createdAt: "2026-05-01T00:00:00.000Z",
    enabledFixes: [],
  });

  await withMockedFetch((request) => {
    const url = new URL(request.url);

    if (
      url.hostname === "custom.example.com" &&
      url.pathname === "/v1/models"
    ) {
      return jsonResponse({ error: { message: "bad custom key" } }, 401);
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey.key,
      },
      body: JSON.stringify({
        model: "custom-chat-model",
        max_tokens: 100,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assertEquals(response.status, 401);
    assertEquals(await response.json(), {
      error: { message: "bad custom key" },
    });
  });
});
