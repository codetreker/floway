import { test } from "vitest";
import { assertEquals, assertRejects } from "../../../../test-assert.ts";
import type { MessagesStreamEventData } from "../../../shared/protocol/messages.ts";
import type {
  ResponsesResult,
  ResponseStreamEvent,
} from "../../../shared/protocol/responses.ts";
import { eventFrame, type ProtocolFrame } from "../../shared/stream/types.ts";
import { responsesResultToEvents } from "../../targets/responses/events/from-result.ts";
import { translateToSourceEvents } from "./events.ts";

type UpstreamResponseStreamEvent = ResponseStreamEvent & {
  sequence_number?: number;
};

const makeResponse = (status: ResponsesResult["status"]): ResponsesResult => ({
  id: "resp_123",
  object: "response",
  model: "gpt-test",
  status,
  output_text: "hello",
  output: [{
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "hello" }],
  }],
  usage: {
    input_tokens: 3,
    output_tokens: 2,
    total_tokens: 5,
  },
});

const toProtocolFrame = (
  event: ResponseStreamEvent,
): ProtocolFrame<UpstreamResponseStreamEvent> =>
  eventFrame({ ...event, sequence_number: 0 });

const drain = async <T>(frames: AsyncIterable<T>): Promise<void> => {
  for await (const _frame of frames) {
    // Exhaust the stream so async translator errors surface to the caller.
  }
};

test("translateToSourceEvents does not emit mixed frames for created+completed fallback", async () => {
  async function* stream() {
    yield toProtocolFrame({
      type: "response.created",
      response: makeResponse("in_progress"),
    });
    yield toProtocolFrame({
      type: "response.completed",
      response: makeResponse("completed"),
    });
  }

  const frames = [];

  for await (const frame of translateToSourceEvents(stream())) {
    frames.push(frame);
  }

  assertEquals(frames.map((frame) => frame.type), [
    "event",
    "event",
    "event",
    "event",
    "event",
    "event",
  ]);
  assertEquals(
    frames.map((frame) =>
      frame.type === "event" ? frame.event.type : frame.type
    ),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ],
  );
});

test("translateToSourceEvents stops after Responses terminal fallback", async () => {
  async function* stream() {
    yield toProtocolFrame({
      type: "response.completed",
      response: makeResponse("completed"),
    });
    yield toProtocolFrame({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: "ignored",
    });
  }

  const frames = [];

  for await (const frame of translateToSourceEvents(stream())) {
    frames.push(frame);
  }

  assertEquals(
    frames.map((frame) =>
      frame.type === "event" ? frame.event.type : frame.type
    ),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ],
  );
});

test("translateToSourceEvents preserves refusal text from JSON fallback", async () => {
  async function* stream() {
    yield* responsesResultToEvents({
      id: "resp_refusal",
      object: "response",
      model: "gpt-test",
      status: "completed",
      output_text: "",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "refusal", refusal: "No." }],
      }],
      usage: {
        input_tokens: 3,
        output_tokens: 1,
        total_tokens: 4,
      },
    });
  }

  const text: string[] = [];

  for await (const frame of translateToSourceEvents(stream())) {
    if (frame.type !== "event") continue;
    if (frame.event.type !== "content_block_delta") continue;
    if (frame.event.delta.type !== "text_delta") continue;

    text.push(frame.event.delta.text);
  }

  assertEquals(text.join(""), "No.");
});

test("translateToSourceEvents translates Responses failed terminal to Messages error", async () => {
  async function* stream() {
    yield toProtocolFrame({
      type: "response.failed",
      response: {
        ...makeResponse("failed"),
        output_text: "",
        output: [],
        error: {
          type: "server_error",
          code: "server_error",
          message: "upstream failed",
        },
      },
    });
    yield toProtocolFrame({
      type: "response.completed",
      response: makeResponse("completed"),
    });
  }

  const frames = [];

  for await (const frame of translateToSourceEvents(stream())) {
    frames.push(frame);
  }

  assertEquals(frames, [
    eventFrame(
      {
        type: "error",
        error: {
          type: "api_error",
          message: "upstream failed",
        },
      } satisfies MessagesStreamEventData,
    ),
  ]);
});

test("translateToSourceEvents translates Responses error terminal to Messages error", async () => {
  async function* stream() {
    yield toProtocolFrame({
      type: "error",
      code: "overloaded_error",
      message: "upstream overloaded",
    });
    yield toProtocolFrame({
      type: "response.completed",
      response: makeResponse("completed"),
    });
  }

  const frames = [];

  for await (const frame of translateToSourceEvents(stream())) {
    frames.push(frame);
  }

  assertEquals(frames, [
    eventFrame(
      {
        type: "error",
        error: {
          type: "api_error",
          message: "upstream overloaded",
        },
      } satisfies MessagesStreamEventData,
    ),
  ]);
});

test("translateToSourceEvents rejects truncated Responses streams without terminal events", async () => {
  async function* stream() {
    yield toProtocolFrame({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: "partial",
    });
  }

  await assertRejects(
    async () => await drain(translateToSourceEvents(stream())),
    Error,
    "Upstream Responses stream ended without a terminal event.",
  );
});
