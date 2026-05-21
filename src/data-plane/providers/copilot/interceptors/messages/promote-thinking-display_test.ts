import { test } from "vitest";
import { assertEquals } from "../../../../../test-assert.ts";
import { eventResult } from "../../../../llm/shared/errors/result.ts";
import type { MessagesStreamEventData } from "../../../../shared/protocol/messages.ts";
import {
  doneFrame,
  eventFrame,
  type ProtocolFrame,
} from "../../../../llm/shared/stream/types.ts";
import type { ModelProvider, UpstreamModel } from "../../../types.ts";
import type { TelemetryModelIdentity } from "../../../../../repo/types.ts";
import type {
  MessagesExchangeContext,
  MessagesExchangeResult,
} from "../../../../llm/interceptors.ts";
import {
  resolveMessagesDownstreamThinkingDisplay,
  withThinkingDisplayPromoted,
} from "./promote-thinking-display.ts";

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

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

const makeCtx = (
  thinking: MessagesExchangeContext["payload"]["thinking"],
  overrides: {
    model?: string;
    sourceApi?: MessagesExchangeContext["sourceApi"];
  } = {},
): MessagesExchangeContext => ({
  sourceApi: overrides.sourceApi ?? "messages",
  targetApi: "messages",
  model: overrides.model ?? "claude-opus-4.7-1m-internal",
  upstream: "test-upstream",
  payload: {
    model: overrides.model ?? "claude-opus-4.7-1m-internal",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 128,
    ...(thinking ? { thinking } : {}),
  },
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFixes: new Set<string>(),
});

const okEvents = (): Promise<MessagesExchangeResult> =>
  Promise.resolve(eventResult(
    (async function* (): AsyncGenerator<
      ProtocolFrame<MessagesStreamEventData>
    > {})(),
    testTelemetryModelIdentity,
  ));

test("resolveMessagesDownstreamThinkingDisplay exposes 4.7+ omitted by default and older Claude as summarized", () => {
  assertEquals(
    resolveMessagesDownstreamThinkingDisplay(makeCtx({ type: "adaptive" })),
    "omitted",
  );
  assertEquals(
    resolveMessagesDownstreamThinkingDisplay({
      ...makeCtx({ type: "adaptive" }),
      payload: {
        ...makeCtx({ type: "adaptive" }).payload,
        model: "claude-opus-4-7-20260219",
      },
    }),
    "omitted",
  );
  assertEquals(
    resolveMessagesDownstreamThinkingDisplay({
      ...makeCtx({ type: "adaptive" }),
      payload: {
        ...makeCtx({ type: "adaptive" }).payload,
        model: "claude-opus-4.6",
      },
    }),
    "summarized",
  );
  assertEquals(
    resolveMessagesDownstreamThinkingDisplay({
      ...makeCtx({ type: "adaptive" }),
      payload: {
        ...makeCtx({ type: "adaptive" }).payload,
        model: "gpt-5.2",
      },
    }),
    "summarized",
  );
});

test("resolveMessagesDownstreamThinkingDisplay preserves explicit display", () => {
  assertEquals(
    resolveMessagesDownstreamThinkingDisplay(
      makeCtx({ type: "adaptive", display: "summarized" }),
    ),
    "summarized",
  );
  assertEquals(
    resolveMessagesDownstreamThinkingDisplay(
      makeCtx({ type: "adaptive", display: "omitted" }),
    ),
    "omitted",
  );
  assertEquals(
    resolveMessagesDownstreamThinkingDisplay(
      makeCtx({ type: "adaptive", display: "full" }),
    ),
    "full",
  );
});

test("resolveMessagesDownstreamThinkingDisplay ignores unknown explicit display values", () => {
  const ctx = makeCtx({ type: "adaptive" });
  (ctx.payload.thinking as { display?: unknown }).display = "omit";

  assertEquals(resolveMessagesDownstreamThinkingDisplay(ctx), undefined);
});

test("withThinkingDisplayPromoted sends summarized upstream when thinking display is omitted", async () => {
  const ctx = makeCtx({ type: "adaptive" });

  await withThinkingDisplayPromoted(ctx, () =>
    Promise.resolve({
      type: "internal-error",
      status: 418,
      error: {
        type: "internal_error",
        name: "Error",
        message: "stop",
        stack: "",
        source_api: "messages",
        target_api: "messages",
      },
    }));

  assertEquals(ctx.payload.thinking?.display, "summarized");
});

test("withThinkingDisplayPromoted overrides omitted but preserves full", async () => {
  const omittedCtx = makeCtx({ type: "adaptive", display: "omitted" });
  const fullCtx = makeCtx({ type: "adaptive", display: "full" });

  await withThinkingDisplayPromoted(omittedCtx, okEvents);
  await withThinkingDisplayPromoted(fullCtx, okEvents);

  assertEquals(omittedCtx.payload.thinking?.display, "summarized");
  assertEquals(fullCtx.payload.thinking?.display, "full");
});

test("withThinkingDisplayPromoted leaves disabled or absent thinking untouched", async () => {
  const disabledCtx = makeCtx({ type: "disabled" });
  const absentCtx = makeCtx(undefined);

  await withThinkingDisplayPromoted(
    disabledCtx,
    okEvents,
  );
  await withThinkingDisplayPromoted(absentCtx, okEvents);

  assertEquals(disabledCtx.payload.thinking, { type: "disabled" });
  assertEquals(absentCtx.payload.thinking, undefined);
});

test("withThinkingDisplayPromoted leaves unknown display values for upstream validation", async () => {
  const ctx = makeCtx({ type: "adaptive" });
  (ctx.payload.thinking as { display?: unknown }).display = "omit";

  await withThinkingDisplayPromoted(
    ctx,
    okEvents,
  );

  assertEquals((ctx.payload.thinking as { display?: unknown }).display, "omit");
});

test("withThinkingDisplayPromoted simulates omitted display on protocol events", async () => {
  const ctx = makeCtx({ type: "adaptive" }, { sourceApi: "responses" });

  const result = await withThinkingDisplayPromoted(
    ctx,
    () =>
      Promise.resolve(eventResult(
        (async function* (): AsyncGenerator<
          ProtocolFrame<MessagesStreamEventData>
        > {
          yield eventFrame<MessagesStreamEventData>({
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "summary prefix" },
          });
          yield eventFrame<MessagesStreamEventData>({
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "summary body" },
          });
          yield eventFrame<MessagesStreamEventData>({
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "sig_unchanged" },
          });
          yield eventFrame<MessagesStreamEventData>({
            type: "content_block_stop",
            index: 0,
          });
          yield doneFrame();
        })(),
        testTelemetryModelIdentity,
      )),
  );

  assertEquals(result.type, "events");
  if (result.type !== "events") throw new Error("expected events");

  assertEquals(await collect(result.events), [
    eventFrame<MessagesStreamEventData>({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    }),
    eventFrame<MessagesStreamEventData>({
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig_unchanged" },
    }),
    eventFrame<MessagesStreamEventData>({
      type: "content_block_stop",
      index: 0,
    }),
    doneFrame(),
  ]);
});
