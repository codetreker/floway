import type { EndpointKey } from '../../shared/upstream/types.ts';
import type { LlmTargetApi } from '../llm/interceptors.ts';
import type { ModelEndpointKey } from '@floway-dev/protocols/common';

export const llmTargetApiToModelEndpoint = (target: LlmTargetApi): ModelEndpointKey => {
  switch (target) {
  case 'messages':
    return 'messages';
  case 'responses':
    return 'responses';
  case 'chat-completions':
    return 'chatCompletions';
  }
};

// Endpoints that the gateway always invokes as Server-Sent Events. The data
// plane treats SSE as the only upstream transport for these endpoints; providers
// inject `stream: true` so middle layers never observe a non-streaming variant.
// `messages_count_tokens` and `embeddings` remain non-streaming JSON.
export const isStreamingEndpoint = (endpoint: EndpointKey): boolean =>
  endpoint === 'chat_completions' || endpoint === 'responses' || endpoint === 'messages';
