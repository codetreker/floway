import type { ModelCapabilities } from '../../../providers/capabilities.ts';

export type GeminiPlan = { target: 'messages' } | { target: 'responses' } | { target: 'chat-completions' };

export const planGeminiRequest = (capabilities: ModelCapabilities): GeminiPlan | null => {
  if (capabilities.supportsChatCompletions) {
    return { target: 'chat-completions' };
  }

  if (capabilities.supportsMessages) {
    return { target: 'messages' };
  }

  if (capabilities.supportsResponses) {
    return { target: 'responses' };
  }
  return null;
};
