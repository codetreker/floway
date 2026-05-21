import { test } from "vitest";
import { assertEquals } from "../../../../../test-assert.ts";
import { chatCompletionResultToEvents } from "./from-result.ts";

test("chatCompletionResultToEvents projects terminal JSON into Chat stream chunks", () => {
  const frames = Array.from(chatCompletionResultToEvents({
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 123,
    model: "gpt-test",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        reasoning_text: "think",
        content: "Hello",
      },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  }));

  assertEquals(frames.map((frame) => frame.type), [
    "event",
    "event",
    "event",
    "event",
    "event",
    "done",
  ]);
  assertEquals(frames[0], {
    type: "event",
    event: {
      id: "chatcmpl_1",
      object: "chat.completion.chunk",
      created: 123,
      model: "gpt-test",
      choices: [{
        index: 0,
        delta: { role: "assistant" },
        finish_reason: null,
      }],
    },
  });
});

test("chatCompletionResultToEvents can hide usage chunks for client-visible streams", () => {
  const frames = Array.from(chatCompletionResultToEvents({
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 123,
    model: "gpt-test",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "Hello" },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  }, { includeUsageChunk: false }));

  assertEquals(
    frames.some((frame) =>
      frame.type === "event" && frame.event.choices.length === 0
    ),
    false,
  );
});

test("chatCompletionResultToEvents preserves all choices from terminal JSON", () => {
  const frames = Array.from(chatCompletionResultToEvents({
    id: "chatcmpl_multi",
    object: "chat.completion",
    created: 123,
    model: "gpt-test",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "first" },
      finish_reason: "stop",
    }, {
      index: 1,
      message: { role: "assistant", content: "second" },
      finish_reason: "length",
    }],
  }, { includeUsageChunk: false }));

  const contentFrame = frames.find((frame) =>
    frame.type === "event" &&
    frame.event.choices.some((choice) => choice.delta.content !== undefined)
  );
  const finishFrame = frames.find((frame) =>
    frame.type === "event" &&
    frame.event.choices.some((choice) => choice.finish_reason !== null)
  );

  assertEquals(contentFrame, {
    type: "event",
    event: {
      id: "chatcmpl_multi",
      object: "chat.completion.chunk",
      created: 123,
      model: "gpt-test",
      choices: [{
        index: 0,
        delta: { content: "first" },
        finish_reason: null,
      }, {
        index: 1,
        delta: { content: "second" },
        finish_reason: null,
      }],
    },
  });
  assertEquals(finishFrame, {
    type: "event",
    event: {
      id: "chatcmpl_multi",
      object: "chat.completion.chunk",
      created: 123,
      model: "gpt-test",
      choices: [{
        index: 0,
        delta: {},
        finish_reason: "stop",
      }, {
        index: 1,
        delta: {},
        finish_reason: "length",
      }],
    },
  });
});

test("chatCompletionResultToEvents preserves reasoning_items from terminal JSON", () => {
  const frames = Array.from(chatCompletionResultToEvents({
    id: "chatcmpl_reasoning_items",
    object: "chat.completion",
    created: 1,
    model: "gpt-test",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: "answer",
        reasoning_items: [{
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "trace" }],
          encrypted_content: "enc_1",
        }],
      },
      finish_reason: "stop",
    }],
  }));

  const reasoningItemsFrame = frames.find((frame) =>
    frame.type === "event" &&
    frame.event.choices[0]?.delta.reasoning_items !== undefined
  );

  assertEquals(
    reasoningItemsFrame?.type === "event"
      ? reasoningItemsFrame.event.choices[0]?.delta.reasoning_items
      : undefined,
    [{
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "trace" }],
      encrypted_content: "enc_1",
    }],
  );
});

test("chatCompletionResultToEvents preserves DeepSeek reasoning_content from terminal JSON", () => {
  const frames = Array.from(chatCompletionResultToEvents({
    id: "chatcmpl_deepseek_json",
    object: "chat.completion",
    created: 1,
    model: "deepseek-reasoner",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: "answer",
        reasoning_text: null,
        reasoning_content: "legacy thinking",
      } as unknown as {
        role: "assistant";
        content: string;
        reasoning_text: null;
        reasoning_content: string;
      },
      finish_reason: "stop",
    }],
  }));

  const reasoningContentFrame = frames.find((frame) =>
    frame.type === "event" &&
    (frame.event.choices[0]?.delta as Record<string, unknown>)
        .reasoning_content !== undefined
  );

  assertEquals(
    reasoningContentFrame?.type === "event"
      ? (reasoningContentFrame.event.choices[0]?.delta as Record<
        string,
        unknown
      >).reasoning_content
      : undefined,
    "legacy thinking",
  );
});
