import { assertEquals } from "@std/assert";
import { modelCapabilitiesFromModel } from "./get-model-capabilities.ts";
import type { ModelInfo } from "../../../models/types.ts";

const baseModel = (overrides: Partial<ModelInfo> = {}): ModelInfo => ({
  id: "test-model",
  name: "Test",
  version: "1",
  object: "model",
  capabilities: {
    family: "test",
    type: "chat",
    limits: {},
    supports: {},
  },
  ...overrides,
});

Deno.test("modelCapabilitiesFromModel honors explicit supported_endpoints", () => {
  const caps = modelCapabilitiesFromModel(baseModel({
    supported_endpoints: ["/v1/messages", "/chat/completions"],
  }));

  assertEquals(caps.supportsMessages, true);
  assertEquals(caps.supportsChatCompletions, true);
  assertEquals(caps.supportsResponses, false);
  assertEquals(caps.hasExplicitCapabilities, true);
});

Deno.test("modelCapabilitiesFromModel detects /responses support", () => {
  const caps = modelCapabilitiesFromModel(baseModel({
    supported_endpoints: ["/responses", "/chat/completions", "ws:/responses"],
  }));

  assertEquals(caps.supportsResponses, true);
  assertEquals(caps.supportsChatCompletions, true);
  assertEquals(caps.supportsMessages, false);
});

Deno.test(
  "modelCapabilitiesFromModel infers chat completions when supported_endpoints is missing on a chat model",
  () => {
    // gpt-4o, gpt-4.1, and other legacy chat models still ship from
    // /chat/completions but no longer carry supported_endpoints in Copilot's
    // /models response.
    const caps = modelCapabilitiesFromModel(baseModel({ id: "gpt-4o" }));

    assertEquals(caps.supportsChatCompletions, true);
    assertEquals(caps.supportsResponses, false);
    assertEquals(caps.supportsMessages, false);
    assertEquals(caps.hasExplicitCapabilities, false);
  },
);

Deno.test(
  "modelCapabilitiesFromModel does not infer chat completions for non-chat capability types",
  () => {
    const caps = modelCapabilitiesFromModel(baseModel({
      id: "text-embedding-3-small",
      capabilities: {
        family: "text-embedding-3-small",
        type: "embeddings",
        limits: {},
        supports: {},
      },
    }));

    assertEquals(caps.supportsChatCompletions, false);
    assertEquals(caps.hasExplicitCapabilities, false);
  },
);

Deno.test(
  "modelCapabilitiesFromModel honors an explicitly empty supported_endpoints array",
  () => {
    // If upstream ever ships an empty list we trust the declaration rather
    // than re-inferring from capabilities.type — that keeps us strict on
    // entries that intentionally opt out of every endpoint.
    const caps = modelCapabilitiesFromModel(baseModel({
      supported_endpoints: [],
    }));

    assertEquals(caps.supportsChatCompletions, false);
    assertEquals(caps.supportsResponses, false);
    assertEquals(caps.supportsMessages, false);
    assertEquals(caps.hasExplicitCapabilities, true);
  },
);
