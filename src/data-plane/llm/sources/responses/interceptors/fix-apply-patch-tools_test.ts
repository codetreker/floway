import { assertEquals, assertFalse } from "@std/assert";
import type { ResponsesPayload } from "../../../../../lib/responses-types.ts";
import { fixApplyPatchTools } from "./fix-apply-patch-tools.ts";

const run = async (payload: ResponsesPayload): Promise<ResponsesPayload> => {
  await fixApplyPatchTools({ payload }, () =>
    Promise.resolve({
      type: "events",
      status: 200,
      headers: new Headers(),
      events: (async function* () {})(),
    } as never));
  return payload;
};

Deno.test("fixApplyPatchTools rewrites the apply_patch custom tool to a function tool", async () => {
  const payload = await run({
    model: "gpt-test",
    input: "edit",
    tools: [
      {
        type: "custom",
        name: "apply_patch",
        description: "raw",
        format: { type: "freeform", syntax: "v4a", definition: "..." },
      },
    ],
  } as ResponsesPayload);

  assertEquals(payload.tools?.length, 1);
  const tool = payload.tools?.[0];
  assertEquals(tool?.type, "function");
  assertEquals(tool?.name, "apply_patch");
  assertEquals(
    (tool as { parameters?: { required?: string[] } }).parameters?.required,
    ["input"],
  );
});

Deno.test("fixApplyPatchTools leaves non-apply_patch custom tools untouched", async () => {
  // strip-unsupported-tools removes them after this interceptor runs; this
  // test pins the responsibility split.
  const payload = await run({
    model: "gpt-test",
    input: "edit",
    tools: [
      { type: "custom", name: "freeform_other", description: "x" },
    ],
  } as ResponsesPayload);

  assertEquals(payload.tools?.length, 1);
  assertEquals(payload.tools?.[0].type, "custom");
});

Deno.test("fixApplyPatchTools rewrites a forced apply_patch custom tool_choice", async () => {
  const payload = await run({
    model: "gpt-test",
    input: "edit",
    tools: [
      {
        type: "function",
        name: "apply_patch",
        parameters: {},
        strict: false,
      },
    ],
    tool_choice: { type: "custom", name: "apply_patch" },
  } as ResponsesPayload);

  assertEquals(payload.tool_choice, { type: "function", name: "apply_patch" });
});

Deno.test("fixApplyPatchTools is a no-op when no apply_patch tool is present", async () => {
  const payload = await run({
    model: "gpt-test",
    input: "edit",
    tools: [
      {
        type: "function",
        name: "lookup",
        parameters: {},
        strict: false,
      },
    ],
    tool_choice: "auto",
  } as ResponsesPayload);

  assertEquals(payload.tools?.length, 1);
  assertEquals(payload.tools?.[0].name, "lookup");
  assertEquals(payload.tool_choice, "auto");
  assertFalse(Array.isArray(payload.tool_choice));
});
