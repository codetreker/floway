import type { ModelCapabilities } from '../../../providers/capabilities.ts';

export type ResponsesPlan = { target: 'responses' } | { target: 'messages' } | { target: 'chat-completions' };

export const planResponsesRequest = (capabilities: ModelCapabilities): ResponsesPlan | null => {
  if (capabilities.supportsResponses) {
    return { target: 'responses' };
  }

  if (capabilities.supportsMessages) {
    return { target: 'messages' };
  }

  if (capabilities.supportsChatCompletions) {
    return { target: 'chat-completions' };
  }

  return null;
};
