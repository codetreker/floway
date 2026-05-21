import { test } from "vitest";
import { assertEquals } from "../../../../../test-assert.ts";
import type { ResponsesPayload } from "../../../../shared/protocol/responses.ts";
import type { ResponsesExchangeContext } from "../../../interceptors.ts";
import {
  stubProvider,
  stubUpstreamModel,
  testTelemetryModelIdentity,
} from "../../../../../test-helpers.ts";
import { eventResult } from "../../../shared/errors/result.ts";
import { doneFrame } from "../../../shared/stream/types.ts";
import { withReasoningDisabledOnForcedToolChoice } from "./disable-reasoning-on-forced-tool-choice.ts";

const okEvents = () =>
  Promise.resolve(
    eventResult(
      (async function* () {
        yield doneFrame();
      })(),
      testTelemetryModelIdentity,
    ),
  );

const exchangeContext = (
  payload: ResponsesPayload,
  enabledFixes: ReadonlySet<string> = new Set(),
): ResponsesExchangeContext => ({
  sourceApi: "responses",
  targetApi: "responses",
  model: payload.model,
  upstream: "test-upstream",
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFixes,
});

test("responses required tool_choice strips reasoning", async () => {
  const input = exchangeContext({
    model: "m",
    input: "hi",
    reasoning: { effort: "high" },
    tool_choice: "required",
  });

  await withReasoningDisabledOnForcedToolChoice(input, okEvents);

  assertEquals(input.payload.reasoning, undefined);
  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.thinking, undefined);
  assertEquals(out.enable_thinking, undefined);
});

test("responses object tool_choice is forced", async () => {
  const input = exchangeContext({
    model: "m",
    input: "hi",
    reasoning: { effort: "high" },
    tool_choice: { type: "custom", name: "x" },
  });

  await withReasoningDisabledOnForcedToolChoice(input, okEvents);

  assertEquals(input.payload.reasoning, undefined);
});

test("responses vendor flags add explicit disable fields", async () => {
  const input = exchangeContext({
    model: "m",
    input: "hi",
    reasoning: { effort: "high" },
    tool_choice: "required",
  }, new Set(["vendor-deepseek", "vendor-qwen"]));

  await withReasoningDisabledOnForcedToolChoice(input, okEvents);

  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.thinking, { type: "disabled" });
  assertEquals(out.enable_thinking, false);
});

test("responses non-forced tool_choice leaves reasoning untouched", async () => {
  for (const tool_choice of ["auto", "none"] as const) {
    const input = exchangeContext({
      model: "m",
      input: "hi",
      reasoning: { effort: "high" },
      tool_choice,
    }, new Set(["vendor-deepseek"]));

    await withReasoningDisabledOnForcedToolChoice(input, okEvents);

    assertEquals(input.payload.reasoning, { effort: "high" });
    const out = input.payload as unknown as Record<string, unknown>;
    assertEquals(out.thinking, undefined);
  }
});
