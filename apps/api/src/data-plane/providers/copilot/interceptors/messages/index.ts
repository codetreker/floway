// Copilot-only Messages workarounds. The Copilot provider attaches these sets
// to its provider metadata, so generic source/target assembly does not need to
// know which provider kind is running.

import { withAnthropicBetaHeaderFiltered } from './filter-anthropic-beta-header.ts';
import { withThinkingDisplayPromoted } from './promote-thinking-display.ts';
import { rewriteContextWindowError } from './rewrite-context-window-error.ts';
import { withInitiatorHeaderSet } from './set-initiator-header.ts';
import { withVisionHeaderSet } from './set-vision-header.ts';
import { stripBillingAttribution } from './strip-billing-attribution.ts';
import { withCacheControlScopeStripped } from './strip-cache-control-scope.ts';
import { withEagerInputStreamingStripped } from './strip-eager-input-streaming.ts';
import type { MessagesCountTokensInterceptor, MessagesInterceptor } from '../../../../llm/interceptors.ts';

// `withMessagesWebSearchShim` is intentionally NOT registered here. It runs
// via the unified source-side optional table (filtered by enabled flags); the
// Copilot provider opts in by listing `messages-web-search-shim` in its
// default flag set (see COPILOT_DEFAULT_FLAGS in ../../provider.ts).
export const messagesCopilotSourceInterceptors = [
  stripBillingAttribution,
  rewriteContextWindowError,
] as const satisfies readonly MessagesInterceptor[];

// Order matters: payload-mutating interceptors run first so the header
// interceptors see the final outgoing payload, then header interceptors
// populate `invocation.headers` for the upstream call.
export const messagesCopilotInterceptors = [
  withThinkingDisplayPromoted,
  withCacheControlScopeStripped,
  withEagerInputStreamingStripped,
  withVisionHeaderSet,
  withInitiatorHeaderSet,
  withAnthropicBetaHeaderFiltered,
] as const satisfies readonly MessagesInterceptor[];

// /v1/messages/count_tokens is a one-shot HTTP exchange that returns the raw
// upstream Response. Pre-Path A the Copilot provider's call helper applied
// vision detection, x-initiator classification, and anthropic-beta allow-list
// filtering to BOTH chat and count_tokens; only count_tokens stopped seeing
// them when the headers moved onto the chat-planning target interceptor
// chain. This list re-instates exactly those three header-shaping workarounds
// at the Copilot count_tokens target boundary so behavior matches pre-Path A
// for count_tokens.
//
// withThinkingDisplayPromoted / withCacheControlScopeStripped /
// withEagerInputStreamingStripped are intentionally absent: pre-Path A they
// also never ran on count_tokens (they lived in the messages target
// interceptor list, not in the shared call() helper).
export const messagesCountTokensCopilotInterceptors = [
  withVisionHeaderSet,
  withInitiatorHeaderSet,
  withAnthropicBetaHeaderFiltered,
] as const satisfies readonly MessagesCountTokensInterceptor[];
