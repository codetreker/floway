import { withMessagesWebSearchShim } from './web-search-shim.ts';
import type { MessagesInterceptor } from '../../../interceptors.ts';

// Source-side Messages interceptors. Every entry is attached to every binding;
// each interceptor's body decides whether to act.
//
//   - withMessagesWebSearchShim: unconditional for translated targets
//     (Responses / Chat Completions cannot carry Anthropic server tools);
//     gated by `messages-web-search-shim` for native Messages targets. Default
//     on for Copilot via the catalog's `defaultFor` field; opt-in for
//     Custom/Azure via per-upstream or per-deployment override.
export const messagesSourceInterceptors: readonly MessagesInterceptor[] = [
  withMessagesWebSearchShim,
];
