import { test } from "vitest";
import { assertEquals } from "../../test-assert.ts";
import {
  copilotModels,
  jsonResponse,
  setupAppTest,
  withMockedFetch,
} from "../../test-helpers.ts";
import { createCopilotProvider } from "./copilot/provider.ts";
import { getCatalogModels, resolveModelForRequest } from "./registry.ts";

test("createCopilotProvider exposes provider-owned requested model aliases", async () => {
  const { githubAccount } = await setupAppTest();
  const instance = await createCopilotProvider(githubAccount);
  const resolveAlias = instance.resolveRequestedModelId;

  assertEquals(
    resolveAlias?.("claude-opus-4-7-20300101"),
    "claude-opus-4-7",
  );
  assertEquals(
    resolveAlias?.("claude-opus-4-7-xhigh-20300101"),
    "claude-opus-4-7",
  );
  assertEquals(resolveAlias?.("claude-opus-4.7"), "claude-opus-4-7");
  assertEquals(resolveAlias?.("codex-auto-review"), undefined);
});

test("getCatalogModels returns public catalog records without execution bindings", async () => {
  const { githubAccount, repo } = await setupAppTest();

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

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-access-token",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (
      url.hostname === "api.githubcopilot.com" && url.pathname === "/models"
    ) {
      return jsonResponse(copilotModels([
        {
          id: "shared-model",
          display_name: "Shared Model",
          supported_endpoints: ["/v1/messages"],
        },
      ]));
    }
    if (
      url.hostname === "custom.example.com" && url.pathname === "/v1/models"
    ) {
      return jsonResponse({
        object: "list",
        data: [{
          id: "shared-model",
          supported_endpoints: ["/chat/completions"],
        }],
      });
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const catalog = await getCatalogModels();
    const model = catalog.find((candidate) => candidate.id === "shared-model");

    assertEquals(model?.display_name, "Shared Model");
    assertEquals(model?.supportedEndpoints, [
      "messages",
      "messages_count_tokens",
      "chat_completions",
    ]);
    assertEquals(model?.supports_generation, true);
    assertEquals(Object.hasOwn(model!, "providers"), false);
    assertEquals(Object.hasOwn(model!, "providerData"), false);

    const resolved = await resolveModelForRequest("shared-model");
    assertEquals(
      resolved.model?.providers.map(({ upstream }) => upstream),
      [`copilot:${githubAccount.user.id}`, "openai:up_custom"],
    );
  });
});

test("resolveModelForRequest applies provider-owned aliases only to that provider", async () => {
  const { githubAccount, repo } = await setupAppTest();

  await repo.upstreamConfigs.save({
    id: "up_custom",
    name: "Custom Provider",
    baseUrl: "https://custom.example.com",
    bearerToken: "sk-custom",
    supportedEndpoints: ["/v1/messages"],
    enabled: true,
    sortOrder: 100,
    createdAt: "2026-05-01T00:00:00.000Z",
    enabledFixes: [],
  });

  await withMockedFetch((request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-access-token",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (
      url.hostname === "api.githubcopilot.com" && url.pathname === "/models"
    ) {
      return jsonResponse(copilotModels([
        { id: "claude-opus-4.7", supported_endpoints: ["/v1/messages"] },
      ]));
    }
    if (
      url.hostname === "custom.example.com" && url.pathname === "/v1/models"
    ) {
      return jsonResponse({
        object: "list",
        data: [{ id: "claude-opus-4-7" }],
      });
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const resolved = await resolveModelForRequest(
      "claude-opus-4-7-20300101",
    );

    assertEquals(resolved.id, "claude-opus-4-7");
    assertEquals(resolved.model?.supportedEndpoints, [
      "messages",
      "messages_count_tokens",
    ]);
    assertEquals(
      resolved.model?.providers.map(({ upstream }) => upstream),
      [`copilot:${githubAccount.user.id}`],
    );
  });
});
