// Copilot-only Responses target workarounds. The Copilot provider attaches
// this set to its provider metadata, so target interceptor assembly does not
// need to know which provider kind is running.

import { withToolArgumentWhitespaceAborted } from './abort-on-tool-argument-whitespace.ts';
import { withConnectionMismatchRetried } from './retry-connection-mismatch.ts';
import { withInitiatorHeaderSet } from './set-initiator-header.ts';
import { withVisionHeaderSet } from './set-vision-header.ts';
import { withImageGenerationStripped } from './strip-image-generation.ts';
import { withServiceTierStripped } from './strip-service-tier.ts';
import { withOutputItemIdsSynchronized } from './synchronize-output-item-ids.ts';
import type { ResponsesInterceptor } from '../../../../llm/interceptors.ts';

// Order matters: payload-mutating interceptors run first so the header
// interceptors see the final outgoing payload, then header interceptors
// populate `invocation.headers` for the upstream call.
export const responsesCopilotInterceptors = [
  withServiceTierStripped,
  withImageGenerationStripped,
  withConnectionMismatchRetried,
  withOutputItemIdsSynchronized,
  withToolArgumentWhitespaceAborted,
  withVisionHeaderSet,
  withInitiatorHeaderSet,
] as const satisfies readonly ResponsesInterceptor[];
