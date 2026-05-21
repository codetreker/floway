import { test } from "vitest";
import { assertEquals, assertRejects } from "../../../../../test-assert.ts";
import { sseFrame } from "../../../shared/stream/types.ts";
import { responsesStreamFramesToEvents } from "./from-stream.ts";

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

test("responsesStreamFramesToEvents parses Responses SSE frames into protocol events", async () => {
  const frames = await collect(
    responsesStreamFramesToEvents((async function* () {
      yield sseFrame(
        JSON.stringify({
          response: {
            id: "resp_1",
            object: "response",
            model: "gpt-test",
            output: [],
            output_text: "",
            status: "in_progress",
          },
          sequence_number: 0,
        }),
        "response.created",
      );
      yield sseFrame("[DONE]");
    })()),
  );

  assertEquals(frames.map((frame) => frame.type), ["event", "done"]);
  assertEquals(frames[0], {
    type: "event",
    event: {
      type: "response.created",
      response: {
        id: "resp_1",
        object: "response",
        model: "gpt-test",
        output: [],
        output_text: "",
        status: "in_progress",
      },
      sequence_number: 0,
    },
  });
});

test("responsesStreamFramesToEvents rejects malformed Responses SSE JSON", async () => {
  await assertRejects(
    async () => {
      await collect(responsesStreamFramesToEvents((async function* () {
        yield sseFrame("not json", "response.output_text.delta");
      })()));
    },
    Error,
    'Malformed upstream Responses SSE JSON for event "response.output_text.delta": not json',
  );
});
