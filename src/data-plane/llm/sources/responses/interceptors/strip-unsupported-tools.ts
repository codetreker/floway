import type { ResponsesPayload } from "../../../../../lib/responses-types.ts";
import type { SourceInterceptor } from "../../run-interceptors.ts";
import type { SourceResponseStreamEvent } from "../events/protocol.ts";
import type { ResponsesSourceContext } from "./types.ts";

// Hosted Responses tool entries Copilot upstream cannot serve and Freeform
// `custom` tools the gateway has no shim for. Codex emits `web_search`,
// `image_generation`, `tool_search`, `namespace`, and `custom` entries under
// `type` alongside ordinary `function` tools — none of those carry a
// translator-friendly `name`/`parameters` pair, so leaking them into
// translation produces malformed Anthropic Messages tool entries
// (`tools.N.custom.name: Field required` is the upstream symptom).
//
// `apply_patch` is the only custom tool the gateway shims, and
// fix-apply-patch-tools rewrites it into a function tool BEFORE this
// interceptor runs, so any remaining `custom` here is a Freeform tool with no
// shim and gets stripped along with the hosted entries.
//
// Once the source-owned web-search shim grows a Responses entry-point we can
// drop `web_search` from this set and let the shim execute it.
//
// References:
// - https://platform.openai.com/docs/guides/tools-image-generation
// - https://github.com/openai/codex/blob/main/codex-rs/tools/src/tool_spec.rs
// - https://github.com/caozhiyuan/copilot-api/blob/1d21b4aca31f89ad49a0c3bf1a71e3561d445855/src/routes/responses/handler.ts#L167-L184
const UNSUPPORTED_RESPONSES_TOOL_TYPES = new Set([
  "image_generation",
  "web_search",
  "tool_search",
  "namespace",
  "custom",
]);

const isUnsupportedToolType = (type: unknown): type is string =>
  typeof type === "string" && UNSUPPORTED_RESPONSES_TOOL_TYPES.has(type);

const stripToolChoice = (
  payload: ResponsesPayload,
  removedUnsupportedTool: boolean,
): void => {
  const choice = payload.tool_choice;

  if (
    choice && typeof choice === "object" &&
    isUnsupportedToolType(choice.type)
  ) {
    delete payload.tool_choice;
    return;
  }

  if (
    removedUnsupportedTool && choice === "required" &&
    (!Array.isArray(payload.tools) || payload.tools.length === 0)
  ) {
    delete payload.tool_choice;
  }
};

/**
 * Strip hosted Responses tool entries Copilot's upstream cannot serve before
 * planning sees the request. This keeps every translation target (native
 * `/responses`, `/v1/messages`, `/chat/completions`) on the same cleaned tools
 * list, and prevents leaking tool entries that lack a `name`/`parameters`
 * pair into translation paths that assume function-shaped tools.
 *
 * Forced tool choices that target a removed entry are dropped along with it.
 * If every tool was removed and the caller forced `required`, drop the choice
 * too — leaving it would force the upstream to invoke a tool that no longer
 * exists.
 */
export const stripUnsupportedToolsFromPayload = (
  payload: ResponsesPayload,
): void => {
  let removedUnsupportedTool = false;

  if (Array.isArray(payload.tools)) {
    const tools = payload.tools.filter((tool) => {
      const unsupported = isUnsupportedToolType(tool.type);
      removedUnsupportedTool ||= unsupported;
      return !unsupported;
    });

    if (tools.length === 0) {
      delete payload.tools;
    } else {
      payload.tools = tools;
    }
  }

  stripToolChoice(payload, removedUnsupportedTool);
};

export const stripUnsupportedTools: SourceInterceptor<
  ResponsesSourceContext,
  SourceResponseStreamEvent
> = (ctx, run) => {
  stripUnsupportedToolsFromPayload(ctx.payload);
  return run();
};
