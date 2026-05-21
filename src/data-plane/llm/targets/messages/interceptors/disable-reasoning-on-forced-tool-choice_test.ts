import { test } from "vitest";
import { assertEquals } from "../../../../../test-assert.ts";
import type {
  MessagesPayload,
  MessagesStreamEventData,
} from "../../../../shared/protocol/messages.ts";
import type {
  ModelProvider,
  UpstreamModel,
} from "../../../../providers/types.ts";
import type { TelemetryModelIdentity } from "../../../../../repo/types.ts";
import type {
  MessagesExchangeContext,
  MessagesExchangeResult,
} from "../../../interceptors.ts";
import { eventResult } from "../../../shared/errors/result.ts";
import type { ProtocolFrame } from "../../../shared/stream/types.ts";
import { withReasoningDisabledOnForcedToolChoice } from "./disable-reasoning-on-forced-tool-choice.ts";

const stubProvider = (): ModelProvider => ({
  getProvidedModels: () => Promise.resolve([]),
  callChatCompletions: () => Promise.reject(new Error("unexpected call")),
  callResponses: () => Promise.reject(new Error("unexpected call")),
  callMessages: () => Promise.reject(new Error("unexpected call")),
  callMessagesCountTokens: () => Promise.reject(new Error("unexpected call")),
  callEmbeddings: () => Promise.reject(new Error("unexpected call")),
});

const stubUpstreamModel = (): UpstreamModel => ({
  id: "test-model",
  name: "test-model",
  version: "test-model",
  object: "model",
  capabilities: {
    family: "test-model",
    type: "chat",
    limits: {},
    supports: {},
  },
  supportedEndpoints: ["messages"],
});

const testTelemetryModelIdentity: TelemetryModelIdentity = {
  model: "test-model",
  upstream: "test-upstream",
  modelKey: "test-model-key",
};

const okEvents = (): Promise<MessagesExchangeResult> =>
  Promise.resolve(
    eventResult(
      (async function* (): AsyncGenerator<
        ProtocolFrame<MessagesStreamEventData>
      > {})(),
      testTelemetryModelIdentity,
    ),
  );

const exchangeContext = (
  payload: MessagesPayload,
): MessagesExchangeContext => ({
  sourceApi: "messages",
  targetApi: "messages",
  model: payload.model,
  upstream: "test-upstream",
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFixes: new Set<string>(),
});

test("messages forced tool_choice disables thinking and strips output_config", async () => {
  const input = exchangeContext({
    model: "m",
    messages: [],
    max_tokens: 1,
    thinking: { type: "enabled", budget_tokens: 1024 },
    output_config: { effort: "high" },
    tool_choice: { type: "tool", name: "x" },
  });

  await withReasoningDisabledOnForcedToolChoice(input, okEvents);

  assertEquals(input.payload.thinking, { type: "disabled" });
  assertEquals(input.payload.output_config, undefined);
});

test("messages any tool_choice also disables thinking", async () => {
  const input = exchangeContext({
    model: "m",
    messages: [],
    max_tokens: 1,
    thinking: { type: "enabled", budget_tokens: 1024 },
    tool_choice: { type: "any" },
  });

  await withReasoningDisabledOnForcedToolChoice(input, okEvents);

  assertEquals(input.payload.thinking, { type: "disabled" });
});

test("messages non-forced tool_choice leaves reasoning untouched", async () => {
  for (const type of ["auto", "none"] as const) {
    const input = exchangeContext({
      model: "m",
      messages: [],
      max_tokens: 1,
      thinking: { type: "enabled", budget_tokens: 1024 },
      tool_choice: { type },
    });

    await withReasoningDisabledOnForcedToolChoice(input, okEvents);

    assertEquals(input.payload.thinking, {
      type: "enabled",
      budget_tokens: 1024,
    });
  }
});
