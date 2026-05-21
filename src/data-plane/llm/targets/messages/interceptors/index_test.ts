import { test } from "vitest";
// Order assertion for the Messages target assembler: base ++ provider ++
// optional. The protocol interceptor runner executes whatever order the
// assembler returns, so this guards interceptor ordering across refactors.

import { assertEquals } from "../../../../../test-assert.ts";
import { messagesCopilotInterceptors } from "../../../../providers/copilot/interceptors/messages/index.ts";
import { withReasoningDisabledOnForcedToolChoice } from "./disable-reasoning-on-forced-tool-choice.ts";
import {
  interceptorsForMessages,
  messagesOptionalInterceptors,
} from "./index.ts";

test("interceptorsForMessages on provider with Copilot interceptors: provider interceptors only", () => {
  const provider = {
    enabledFixes: new Set<string>(),
    targetInterceptors: { messages: messagesCopilotInterceptors },
  };
  const assembled = interceptorsForMessages(provider);

  assertEquals(assembled, [...messagesCopilotInterceptors]);
});

test("interceptorsForMessages on provider without provider interceptors or opt-ins: empty assembly", () => {
  const provider = {
    enabledFixes: new Set<string>(),
  };
  const assembled = interceptorsForMessages(provider);

  assertEquals(assembled, []);
  for (const interceptor of messagesCopilotInterceptors) {
    assertEquals(
      assembled.includes(interceptor),
      false,
      "providers must not pick up Copilot-only interceptors unless they attach them",
    );
  }
});

test("interceptorsForMessages picks up disable-reasoning-on-forced-tool-choice when opted in", () => {
  const provider = {
    enabledFixes: new Set(["disable-reasoning-on-forced-tool-choice"]),
  };
  assertEquals(
    interceptorsForMessages(provider),
    [withReasoningDisabledOnForcedToolChoice],
  );
});

test("messagesOptionalInterceptors registers disable-reasoning-on-forced-tool-choice", () => {
  const descriptor = messagesOptionalInterceptors.find(
    (d) => d.fixId === "disable-reasoning-on-forced-tool-choice",
  );
  if (!descriptor) throw new Error("expected interceptor to be registered");
});
