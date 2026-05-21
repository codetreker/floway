import { test } from "vitest";
import { assertEquals } from "../../../test-assert.ts";
import { mergeClaudeVariants } from "./merge-claude-variants.ts";
import type { CopilotModelsResponse, CopilotRawModel } from "./types.ts";

const assertSameSet = <T>(actual: readonly T[] | undefined, expected: T[]) => {
  // Union order follows the input variant order, which is an implementation
  // detail of upstream /models. Assert membership only so the tests do not
  // flake when upstream reorders.
  assertEquals(new Set(actual), new Set(expected));
  assertEquals(actual?.length, expected.length);
};

const claudeVariant = (
  id: string,
  overrides: {
    maxContextWindowTokens?: number;
    maxPromptTokens?: number;
    maxOutputTokens?: number;
    reasoningEfforts?: string[];
    multiplier?: number;
    restrictedTo?: string[];
  } = {},
): CopilotRawModel => ({
  id,
  name: id,
  version: id,
  display_name: id,
  object: "model",
  capabilities: {
    family: id,
    type: "chat",
    limits: {
      ...(overrides.maxContextWindowTokens !== undefined
        ? { max_context_window_tokens: overrides.maxContextWindowTokens }
        : {}),
      ...(overrides.maxPromptTokens !== undefined
        ? { max_prompt_tokens: overrides.maxPromptTokens }
        : {}),
      ...(overrides.maxOutputTokens !== undefined
        ? { max_output_tokens: overrides.maxOutputTokens }
        : {}),
    },
    supports: {
      ...(overrides.reasoningEfforts !== undefined
        ? { reasoning_effort: overrides.reasoningEfforts }
        : {}),
    },
  },
  supported_endpoints: ["/v1/messages", "/chat/completions"],
  ...(overrides.multiplier !== undefined || overrides.restrictedTo !== undefined
    ? {
      billing: {
        is_premium: true,
        ...(overrides.multiplier !== undefined
          ? { multiplier: overrides.multiplier }
          : {}),
        ...(overrides.restrictedTo !== undefined
          ? { restricted_to: overrides.restrictedTo }
          : {}),
      },
    }
    : {}),
});

test("mergeClaudeVariants merges 4.7 base + high + xhigh + 1m-internal", () => {
  const input: CopilotModelsResponse = {
    object: "list",
    data: [
      claudeVariant("claude-opus-4.7-1m-internal", {
        maxContextWindowTokens: 1_000_000,
        maxPromptTokens: 936_000,
        maxOutputTokens: 64_000,
        reasoningEfforts: ["low", "medium", "high", "xhigh"],
        multiplier: 10,
        restrictedTo: ["enterprise"],
      }),
      claudeVariant("claude-opus-4.7-high", {
        maxContextWindowTokens: 200_000,
        maxPromptTokens: 168_000,
        maxOutputTokens: 32_000,
        reasoningEfforts: ["high"],
        multiplier: 30,
        restrictedTo: ["pro_plus", "business", "enterprise", "max"],
      }),
      claudeVariant("claude-opus-4.7-xhigh", {
        maxContextWindowTokens: 200_000,
        maxPromptTokens: 168_000,
        maxOutputTokens: 32_000,
        reasoningEfforts: ["xhigh"],
        multiplier: 45,
        restrictedTo: ["pro_plus", "business", "enterprise", "max"],
      }),
      {
        ...claudeVariant("claude-opus-4.7", {
          maxContextWindowTokens: 200_000,
          maxPromptTokens: 168_000,
          maxOutputTokens: 32_000,
          reasoningEfforts: ["medium"],
          multiplier: 15,
          restrictedTo: ["pro_plus", "business", "enterprise", "max"],
        }),
        name: "Claude Opus 4.7",
        display_name: "Claude Opus 4.7",
      },
    ],
  };

  const merged = mergeClaudeVariants(input);
  assertEquals(merged.data.length, 1);
  const m = merged.data[0];
  const capabilities = m.capabilities!;

  assertEquals(m.id, "claude-opus-4-7");
  assertEquals(m.name, "Claude Opus 4.7");
  assertEquals(m.version, "claude-opus-4-7");
  assertEquals(m.display_name, "Claude Opus 4.7");
  assertEquals(capabilities.family, "claude-opus-4-7");
  assertEquals(capabilities.limits?.max_context_window_tokens, 1_000_000);
  assertEquals(capabilities.limits?.max_prompt_tokens, 936_000);
  assertEquals(capabilities.limits?.max_output_tokens, 64_000);
  assertSameSet(capabilities.supports?.reasoning_effort, [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  // billing.multiplier intentionally takes the base value (15), not max.
  assertEquals(m.billing?.multiplier, 15);
  // billing.restricted_to takes the union across siblings.
  assertSameSet(m.billing?.restricted_to, [
    "enterprise",
    "pro_plus",
    "business",
    "max",
  ]);
});

test("mergeClaudeVariants merges 4.6 base + 1m", () => {
  const input: CopilotModelsResponse = {
    object: "list",
    data: [
      claudeVariant("claude-opus-4.6-1m", {
        maxContextWindowTokens: 1_000_000,
        maxPromptTokens: 936_000,
        maxOutputTokens: 64_000,
        multiplier: 6,
        restrictedTo: ["pro", "pro_plus", "business", "enterprise", "max"],
      }),
      claudeVariant("claude-opus-4.6", {
        maxContextWindowTokens: 200_000,
        maxPromptTokens: 168_000,
        maxOutputTokens: 32_000,
        multiplier: 3,
        restrictedTo: [
          "pro",
          "pro_plus",
          "individual_trial",
          "business",
          "enterprise",
          "max",
        ],
      }),
    ],
  };

  const merged = mergeClaudeVariants(input);
  assertEquals(merged.data.length, 1);
  const m = merged.data[0];
  const capabilities = m.capabilities!;

  assertEquals(m.id, "claude-opus-4-6");
  assertEquals(capabilities.limits?.max_context_window_tokens, 1_000_000);
  assertEquals(capabilities.limits?.max_prompt_tokens, 936_000);
  assertEquals(capabilities.limits?.max_output_tokens, 64_000);
  assertEquals(m.billing?.multiplier, 3);
  assertSameSet(m.billing?.restricted_to, [
    "pro",
    "pro_plus",
    "business",
    "enterprise",
    "max",
    "individual_trial",
  ]);
});

test("mergeClaudeVariants leaves non-Claude models untouched", () => {
  const input: CopilotModelsResponse = {
    object: "list",
    data: [
      claudeVariant("gpt-5.4", { maxContextWindowTokens: 272_000 }),
      claudeVariant("gemini-2.5-pro", { maxContextWindowTokens: 1_000_000 }),
    ],
  };

  const merged = mergeClaudeVariants(input);
  assertEquals(merged.data.map((m) => m.id), ["gpt-5.4", "gemini-2.5-pro"]);
  assertEquals(
    merged.data[0].capabilities?.limits?.max_context_window_tokens,
    272_000,
  );
});

test("mergeClaudeVariants preserves order across mixed claude/non-claude models", () => {
  const input: CopilotModelsResponse = {
    object: "list",
    data: [
      claudeVariant("claude-opus-4.7-1m-internal"),
      claudeVariant("gpt-5.5"),
      claudeVariant("claude-opus-4.7"),
      claudeVariant("claude-sonnet-4.6"),
    ],
  };

  const merged = mergeClaudeVariants(input);
  assertEquals(merged.data.map((m) => m.id), [
    "claude-opus-4-7",
    "gpt-5.5",
    "claude-sonnet-4-6",
  ]);
});
