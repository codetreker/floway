import { test } from "vitest";
import { assertEquals, assertRejects } from "../../../../test-assert.ts";
import type { ChatCompletionChunk } from "../../../shared/protocol/chat-completions.ts";
import type { ResponseStreamEvent } from "../../../shared/protocol/responses.ts";
import { eventFrame } from "../../shared/stream/types.ts";
import {
  createChatCompletionsToResponsesStreamState,
  flushChatCompletionsToResponsesEvents,
  translateChatCompletionsChunkToResponsesEvents,
  translateToSourceEvents,
} from "./events.ts";

type ResponseCompletedEvent = Extract<
  ResponseStreamEvent,
  { type: "response.completed" }
>;

type ResponseIncompleteEvent = Extract<
  ResponseStreamEvent,
  { type: "response.incomplete" }
>;

const chunk = (
  delta: ChatCompletionChunk["choices"][0]["delta"],
  finishReason: ChatCompletionChunk["choices"][0]["finish_reason"] = null,
  usage?: ChatCompletionChunk["usage"],
): ChatCompletionChunk => ({
  id: "chatcmpl_stream_test",
  object: "chat.completion.chunk",
  created: 1,
  model: "gpt-test",
  choices: [{ index: 0, delta, finish_reason: finishReason }],
  ...(usage ? { usage } : {}),
});

const translate = (
  chunks: ChatCompletionChunk[],
): ResponseStreamEvent[] => {
  const state = createChatCompletionsToResponsesStreamState();
  return [
    ...chunks.flatMap((item) =>
      translateChatCompletionsChunkToResponsesEvents(item, state)
    ),
    ...flushChatCompletionsToResponsesEvents(state),
  ];
};

const sequenceNumbers = (events: ResponseStreamEvent[]): number[] =>
  events.map((event) =>
    (event as ResponseStreamEvent & { sequence_number: number })
      .sequence_number
  );

const drain = async <T>(frames: AsyncIterable<T>): Promise<void> => {
  for await (const _frame of frames) {
    // Exhaust the stream so async translator errors surface to the caller.
  }
};

test("translateChatCompletionsChunkToResponsesEvents preserves tool call deltas and terminal output", () => {
  const events = translate([
    chunk({ role: "assistant" }),
    chunk({
      tool_calls: [{
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "lookup", arguments: '{"q"' },
      }],
    }),
    chunk({
      tool_calls: [{
        index: 0,
        function: { arguments: ':"x"}' },
      }],
    }),
    chunk({}, "tool_calls"),
  ]);

  const argumentDeltas = events.filter((event) =>
    event.type === "response.function_call_arguments.delta"
  ) as Extract<
    ResponseStreamEvent,
    { type: "response.function_call_arguments.delta" }
  >[];
  const completed = events.find((event) =>
    event.type === "response.completed"
  ) as ResponseCompletedEvent | undefined;

  assertEquals(argumentDeltas.map((event) => event.delta), [
    '{"q"',
    ':"x"}',
  ]);
  assertEquals(completed?.response.output, [{
    type: "function_call",
    call_id: "call_1",
    name: "lookup",
    arguments: '{"q":"x"}',
    status: "completed",
  }]);
  assertEquals(sequenceNumbers(events), events.map((_, index) => index));
});

test("translateChatCompletionsChunkToResponsesEvents replaces buffered scalar reasoning with carrier items", () => {
  const events = translate([
    chunk({ role: "assistant" }),
    chunk({ reasoning_text: "trace" }),
    chunk({ content: "answer" }),
    chunk({
      reasoning_items: [{
        type: "reasoning",
        id: "rs_carrier",
        summary: [{ type: "summary_text", text: "trace" }],
        encrypted_content: "sig",
      }],
    }),
    chunk({}, "stop"),
  ]);

  const completed = events.find((event) =>
    event.type === "response.completed"
  ) as ResponseCompletedEvent | undefined;

  assertEquals(completed?.response.output, [
    {
      type: "reasoning",
      id: "rs_carrier",
      summary: [{ type: "summary_text", text: "trace" }],
      encrypted_content: "sig",
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "answer" }],
    },
  ]);
});

test("translateChatCompletionsChunkToResponsesEvents maps usage on incomplete length terminal", () => {
  const events = translate([
    chunk({ role: "assistant" }),
    chunk({ content: "partial" }),
    chunk({}, "length", {
      prompt_tokens: 4,
      completion_tokens: 6,
      total_tokens: 10,
      prompt_tokens_details: { cached_tokens: 1 },
      completion_tokens_details: {
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
        reasoning_tokens: 2,
      },
    }),
  ]);

  const incomplete = events.find((event) =>
    event.type === "response.incomplete"
  ) as ResponseIncompleteEvent | undefined;

  assertEquals(incomplete?.response.status, "incomplete");
  assertEquals(incomplete?.response.incomplete_details, {
    reason: "max_output_tokens",
  });
  assertEquals(incomplete?.response.usage, {
    input_tokens: 4,
    output_tokens: 6,
    total_tokens: 10,
    input_tokens_details: { cached_tokens: 1 },
  });
});

test("translateToSourceEvents rejects Chat streams without DONE", async () => {
  async function* stream() {
    yield eventFrame(
      {
        id: "chatcmpl_truncated",
        object: "chat.completion.chunk",
        created: 123,
        model: "gpt-test",
        choices: [{
          index: 0,
          delta: { role: "assistant", content: "partial" },
          finish_reason: "stop",
        }],
      } satisfies ChatCompletionChunk,
    );
  }

  await assertRejects(
    async () => await drain(translateToSourceEvents(stream())),
    Error,
    "Upstream Chat Completions stream ended without a DONE sentinel.",
  );
});
