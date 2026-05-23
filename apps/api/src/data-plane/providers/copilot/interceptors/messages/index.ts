// Copilot-only Messages workarounds. The Copilot provider attaches these sets
// to its provider metadata, so generic source/target assembly does not need to
// know which provider kind is running.

import { withThinkingDisplayPromoted } from './promote-thinking-display.ts';
import { rewriteContextWindowError } from './rewrite-context-window-error.ts';
import { stripBillingAttribution } from './strip-billing-attribution.ts';
import { withCacheControlScopeStripped } from './strip-cache-control-scope.ts';
import { withEagerInputStreamingStripped } from './strip-eager-input-streaming.ts';
import type { MessagesInterceptor } from '../../../../llm/interceptors.ts';

// `withMessagesWebSearchShim` is intentionally NOT registered here. It runs
// via the unified source-side optional table (filtered by enabled flags); the
// Copilot provider opts in by listing `messages-web-search-shim` in its
// default flag set (see COPILOT_DEFAULT_FLAGS in ../../provider.ts).
export const messagesCopilotSourceInterceptors = [stripBillingAttribution, rewriteContextWindowError] as const satisfies readonly MessagesInterceptor[];

export const messagesCopilotInterceptors = [withThinkingDisplayPromoted, withCacheControlScopeStripped, withEagerInputStreamingStripped] as const satisfies readonly MessagesInterceptor[];
