// Copilot-only Chat Completions workarounds. The boundary chain runs inside
// `provider.callChatCompletions`, so the gateway main flow never knows that
// Copilot has Chat Completions interceptors at all.

import { withToolArgumentWhitespaceAborted } from './abort-on-tool-argument-whitespace.ts';
import { withCacheControlMarkersAttached } from './attach-cache-control-markers.ts';
import { withInlineImagesCompressed } from './compress-images.ts';
import { withInitiatorHeaderSet } from './set-initiator-header.ts';
import { withVisionHeaderSet } from './set-vision-header.ts';
import type { CopilotChatCompletionsBoundaryInterceptor } from './types.ts';

// Order matters: payload-mutating interceptors run first so the header
// interceptors see the final outgoing payload, then header interceptors
// populate the boundary header bag for the upstream call. Cache-control marker
// attachment is a payload mutator, so it sits with the other payload mutators
// and before any header derivation.
export const COPILOT_CHATCOMPLETIONS_BOUNDARY = [
  withInlineImagesCompressed,
  withToolArgumentWhitespaceAborted,
  withCacheControlMarkersAttached,
  withInitiatorHeaderSet,
  withVisionHeaderSet,
] as const satisfies readonly CopilotChatCompletionsBoundaryInterceptor[];
