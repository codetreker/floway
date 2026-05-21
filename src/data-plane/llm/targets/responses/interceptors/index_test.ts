import { test } from "vitest";
// Order assertion for the Responses target assembler.

import { assertEquals } from "../../../../../test-assert.ts";
import { responsesCopilotInterceptors } from "../../../../providers/copilot/interceptors/responses/index.ts";
import {
  interceptorsForResponses,
  responsesOptionalInterceptors,
} from "./index.ts";
import { withCyberPolicyRetried } from "./retry-cyber-policy.ts";

test("interceptorsForResponses on provider with Copilot interceptors and retry-cyber-policy", () => {
  const provider = {
    enabledFixes: new Set(["retry-cyber-policy"]),
    targetInterceptors: { responses: responsesCopilotInterceptors },
  };
  const assembled = interceptorsForResponses(provider);

  assertEquals(
    assembled,
    [...responsesCopilotInterceptors, withCyberPolicyRetried],
  );
});

test("interceptorsForResponses on provider with Copilot interceptors and no enabled fixes: only provider block", () => {
  const provider = {
    enabledFixes: new Set<string>(),
    targetInterceptors: { responses: responsesCopilotInterceptors },
  };
  const assembled = interceptorsForResponses(provider);

  assertEquals(assembled, [...responsesCopilotInterceptors]);
});

test("interceptorsForResponses without provider interceptors: opt-in only by enabledFixes", () => {
  const without = interceptorsForResponses({
    enabledFixes: new Set<string>(),
  });
  assertEquals(without, []);
  for (const interceptor of responsesCopilotInterceptors) {
    assertEquals(without.includes(interceptor), false);
  }

  const withFix = interceptorsForResponses({
    enabledFixes: new Set(["retry-cyber-policy"]),
  });
  assertEquals(withFix, [withCyberPolicyRetried]);
});

test("interceptorsForResponses ignores unknown enabledFixes silently at the assembler layer", () => {
  // Control plane rejects unknown ids on write; repo doesn't filter by
  // catalog on read, so unknown ids from older snapshots can reach the
  // assembler. The optional filter is a no-op on ids that don't match a
  // registered descriptor — confirm that behavior so a typo'd id doesn't
  // crash the assembler.
  const provider = {
    enabledFixes: new Set(["totally-made-up-fix"]),
  };
  assertEquals(interceptorsForResponses(provider), []);
  // And the descriptor list itself isn't polluted with that id.
  const ids: readonly string[] = responsesOptionalInterceptors.map((d) =>
    d.fixId
  );
  assertEquals(ids.includes("totally-made-up-fix"), false);
});
