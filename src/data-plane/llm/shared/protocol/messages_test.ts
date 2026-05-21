import { test } from "vitest";
import { assertEquals } from "../../../../test-assert.ts";
import { messagesResultToEvents } from "./messages.ts";

test("messagesResultToEvents projects terminal JSON into Messages stream events", () => {
  const frames = Array.from(messagesResultToEvents({
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hello" }],
    model: "claude-test",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2 },
  }));

  assertEquals(frames.map((frame) => frame.type), [
    "event",
    "event",
    "event",
    "event",
    "event",
    "event",
  ]);
  assertEquals(frames.map((frame) => frame.event.type), [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
});

test("messagesResultToEvents preserves protocol citation url fields", () => {
  const frames = Array.from(messagesResultToEvents({
    id: "msg_citation",
    type: "message",
    role: "assistant",
    content: [{
      type: "text",
      text: "Cited answer",
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
    usage: { input_tokens: 3, output_tokens: 2 },
  }));

  const citationFrame = frames.find((frame) =>
    frame.event.type === "content_block_delta" &&
    frame.event.delta.type === "citations_delta"
  );

  assertEquals(
    citationFrame?.event.type === "content_block_delta" &&
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

test("messagesResultToEvents omits signature deltas for text-only thinking blocks", () => {
  const frames = Array.from(messagesResultToEvents({
    id: "msg_text_only_thinking",
    type: "message",
    role: "assistant",
    content: [{ type: "thinking", thinking: "trace" }],
    model: "claude-test",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 2 },
  }));

  assertEquals(
    frames
      .filter((frame) => frame.event.type === "content_block_delta")
      .map((frame) => frame.event),
    [{
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "trace" },
    }],
  );
});
