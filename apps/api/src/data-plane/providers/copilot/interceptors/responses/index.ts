// Copilot-only Responses target workarounds. The Copilot provider attaches
// this set to its provider metadata, so target interceptor assembly does not
// need to know which provider kind is running.

import { withResponsesToolArgumentWhitespaceAborted } from './abort-on-tool-argument-whitespace.ts';
import { withConnectionMismatchRetried } from './retry-connection-mismatch.ts';
import { withServiceTierStripped } from './strip-service-tier.ts';
import { withOutputItemIdsSynchronized } from './synchronize-output-item-ids.ts';
import type { ResponsesInterceptor } from '../../../../llm/interceptors.ts';

export const responsesCopilotInterceptors = [
  withServiceTierStripped,
  withConnectionMismatchRetried,
  withOutputItemIdsSynchronized,
  withResponsesToolArgumentWhitespaceAborted,
] as const satisfies readonly ResponsesInterceptor[];
