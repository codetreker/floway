import { test } from "vitest";
import { assertEquals, assertRejects } from "../../../../../test-assert.ts";
import type { MessagesResponse } from "../../../../shared/protocol/messages.ts";
import { jsonFrame, sseFrame } from "../../../shared/stream/types.ts";
import { messagesStreamFramesToEvents } from "./from-stream.ts";

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

test("messagesStreamFramesToEvents parses Messages SSE frames into protocol events", async () => {
  const frames = await collect(
    messagesStreamFramesToEvents((async function* () {
      yield sseFrame("", "ping");
      yield sseFrame(
        JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-test",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        }),
        "message_start",
      );
      yield sseFrame("[DONE]");
    })()),
  );

  assertEquals(frames.map((frame) => frame.type), ["event", "done"]);
  assertEquals(frames[0], {
    type: "event",
    event: {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-test",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
  });
});

test("messagesStreamFramesToEvents rejects malformed Messages SSE JSON", async () => {
  await assertRejects(
    async () => {
      await collect(messagesStreamFramesToEvents((async function* () {
        yield sseFrame("not json", "message_delta");
      })()));
    },
    Error,
    'Malformed upstream Messages SSE JSON for event "message_delta": not json',
  );
});

test("messagesStreamFramesToEvents projects JSON Messages citations as protocol url fields", async () => {
  const frames = await collect(
    messagesStreamFramesToEvents((async function* () {
      const response: MessagesResponse = {
        id: "msg_json_citations",
        type: "message",
        role: "assistant",
        content: [{
          type: "text",
          text: "quoted",
          citations: [{
            type: "search_result_location",
            url: "https://example.com/protocol",
            title: "Protocol Citation",
            search_result_index: 0,
            start_block_index: 0,
            end_block_index: 0,
          }],
        }],
        model: "claude-test",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      yield jsonFrame(response);
    })()),
  );

  const citationFrame = frames.find((frame) =>
    frame.type === "event" &&
    frame.event.type === "content_block_delta" &&
    frame.event.delta.type === "citations_delta"
  );

  assertEquals(
    citationFrame?.type === "event" &&
      citationFrame.event.type === "content_block_delta" &&
      citationFrame.event.delta.type === "citations_delta"
      ? citationFrame.event.delta.citation
      : undefined,
    {
      type: "search_result_location",
      url: "https://example.com/protocol",
      title: "Protocol Citation",
      search_result_index: 0,
      start_block_index: 0,
      end_block_index: 0,
    },
  );
});
