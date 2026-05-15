import type {
  ResponseFunctionTool,
  ResponsesPayload,
  ResponseTool,
} from "../../../../../lib/responses-types.ts";
import type { SourceInterceptor } from "../../run-interceptors.ts";
import type { SourceResponseStreamEvent } from "../events/protocol.ts";
import type { ResponsesSourceContext } from "./types.ts";

const APPLY_PATCH_FUNCTION_TOOL: ResponseFunctionTool = {
  type: "function",
  name: "apply_patch",
  description: "Use the `apply_patch` tool to edit files",
  parameters: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "The entire contents of the apply_patch command",
      },
    },
    required: ["input"],
    additionalProperties: false,
  },
  strict: false,
};

const isApplyPatchCustomTool = (tool: ResponseTool): boolean =>
  tool.type === "custom" && tool.name === "apply_patch";

/**
 * Public Responses supports both function tools and custom tools, but
 * editor-style `apply_patch` flows are more interoperable when exposed as a
 * function tool with a single `input` string parameter. Codex expects that
 * parameter name, and other Copilot gateways normalize to the same shape.
 *
 * We do this in source so both native `/responses` and translated
 * `/chat/completions -> /responses` traffic share one schema before routing.
 * We also rewrite a forced `tool_choice` that targets the custom variant so
 * downstream targets see a consistent function-tool reference.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/afb7a5c77bdd8a04e57f1c8d210a8659cd28b1f8
 * - https://platform.openai.com/docs/guides/function-calling
 */
const fixPayload = (payload: ResponsesPayload): void => {
  if (Array.isArray(payload.tools)) {
    payload.tools = payload.tools.map((tool) =>
      isApplyPatchCustomTool(tool) ? APPLY_PATCH_FUNCTION_TOOL : tool
    );
  }

  const choice = payload.tool_choice;
  if (
    choice && typeof choice === "object" &&
    choice.type === "custom" &&
    choice.name === "apply_patch"
  ) {
    payload.tool_choice = { type: "function", name: "apply_patch" };
  }
};

export const fixApplyPatchTools: SourceInterceptor<
  ResponsesSourceContext,
  SourceResponseStreamEvent
> = (ctx, run) => {
  fixPayload(ctx.payload);
  return run();
};
