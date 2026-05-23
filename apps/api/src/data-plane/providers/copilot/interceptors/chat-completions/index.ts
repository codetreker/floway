// Copilot-only Chat Completions target workarounds. The Copilot provider
// attaches this set to its provider metadata, so target interceptor assembly
// does not need to know which provider kind is running.

import { withChatToolArgumentWhitespaceAborted } from './abort-on-tool-argument-whitespace.ts';
import type { ChatCompletionsInterceptor } from '../../../../llm/interceptors.ts';

export const chatCompletionsCopilotInterceptors = [withChatToolArgumentWhitespaceAborted] as const satisfies readonly ChatCompletionsInterceptor[];
