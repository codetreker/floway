import type { ModelCapabilities } from '../../../providers/capabilities.ts';

export type MessagesPlan = { target: 'messages' } | { target: 'responses' } | { target: 'chat-completions' };

export const planMessagesRequest = (capabilities: ModelCapabilities): MessagesPlan | null => {
  if (capabilities.supportsMessages) {
    return { target: 'messages' };
  }

  if (capabilities.supportsResponses) {
    return { target: 'responses' };
  }

  if (capabilities.supportsChatCompletions) {
    return { target: 'chat-completions' };
  }
  return null;
};
