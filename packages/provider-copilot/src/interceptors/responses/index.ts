// Copilot-only Responses workarounds. Each list is a boundary chain the
// Copilot provider runs inside its own `callX` methods, so the gateway main
// flow never knows that Copilot has Responses interceptors at all.

import { withToolArgumentWhitespaceAborted } from './abort-on-tool-argument-whitespace.ts';
import { withInlineImagesCompressed } from './compress-images.ts';
import { withStoreForcedFalse } from './force-store-false.ts';
import { withInitiatorHeaderSet } from './set-initiator-header.ts';
import { withVisionHeaderSet } from './set-vision-header.ts';
import { withImageGenerationStripped } from './strip-image-generation.ts';
import { withServiceTierStripped } from './strip-service-tier.ts';
import { withOutputItemIdsSynchronized } from './synchronize-output-item-ids.ts';
import type { CopilotResponsesBoundaryInterceptor, CopilotResponsesCompactBoundaryInterceptor } from './types.ts';

// Streaming `/responses` chain. Order matters: payload-mutating interceptors
// run first so the header interceptors see the final outgoing payload, then
// header interceptors populate the boundary header bag for the upstream call.
export const COPILOT_RESPONSES_BOUNDARY = [
  withInlineImagesCompressed,
  withServiceTierStripped,
  withImageGenerationStripped,
  withStoreForcedFalse,
  withOutputItemIdsSynchronized,
  withToolArgumentWhitespaceAborted,
  withVisionHeaderSet,
  withInitiatorHeaderSet,
] as const satisfies readonly CopilotResponsesBoundaryInterceptor[];

// Non-streaming `/responses/compact` chain. The compact terminal produces a
// `response.compaction` envelope as a value, not a stream, so the two
// event-stream mutators (`withToolArgumentWhitespaceAborted`,
// `withOutputItemIdsSynchronized`) are omitted — they only inspect frames
// after `run()` resolves. Every other Copilot-side payload/header workaround
// applies identically: `/responses/compact` still rejects `store: true`,
// still chokes on `image_generation` tools, still ignores `service_tier`,
// and still wants the same vision / initiator headers when applicable.
export const COPILOT_RESPONSES_COMPACT_BOUNDARY = [
  withInlineImagesCompressed,
  withServiceTierStripped,
  withImageGenerationStripped,
  withStoreForcedFalse,
  withVisionHeaderSet,
  withInitiatorHeaderSet,
] as const satisfies readonly CopilotResponsesCompactBoundaryInterceptor[];
