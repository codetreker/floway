import type { ModelCapabilities } from '../../../providers/capabilities.ts';

export type ChatPlan = { target: 'messages' } | { target: 'responses' } | { target: 'chat-completions' };

export const planChatRequest = (capabilities: ModelCapabilities): ChatPlan | null => {
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
