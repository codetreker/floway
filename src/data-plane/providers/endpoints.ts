import type { ModelEndpoint } from './types.ts';

export type { ModelEndpoint };

export type LlmTargetApi = 'messages' | 'responses' | 'chat-completions';

export const llmTargetApiToModelEndpoint = (target: LlmTargetApi): ModelEndpoint => {
  switch (target) {
  case 'messages':
    return 'messages';
  case 'responses':
    return 'responses';
  case 'chat-completions':
    return 'chat_completions';
  }
};

const ENDPOINT_TO_PUBLIC_PATH: Record<ModelEndpoint, string> = {
  chat_completions: '/chat/completions',
  responses: '/responses',
  messages: '/v1/messages',
  messages_count_tokens: '/v1/messages/count_tokens',
  embeddings: '/embeddings',
};

export const modelEndpointToPublicPath = (endpoint: ModelEndpoint): string => ENDPOINT_TO_PUBLIC_PATH[endpoint];

export const publicPathToModelEndpoint = (path: string): ModelEndpoint | undefined => {
  switch (path) {
  case '/chat/completions':
  case '/v1/chat/completions':
    return 'chat_completions';
  case '/responses':
  case '/v1/responses':
    return 'responses';
  case '/v1/messages':
  case '/messages':
    return 'messages';
  case '/v1/messages/count_tokens':
  case '/messages/count_tokens':
    return 'messages_count_tokens';
  case '/embeddings':
  case '/v1/embeddings':
    return 'embeddings';
  default:
    return undefined;
  }
};

export const publicPathsToModelEndpoints = (paths: readonly string[]): ModelEndpoint[] => {
  const endpoints: ModelEndpoint[] = [];
  for (const path of paths) {
    const endpoint = publicPathToModelEndpoint(path);
    if (endpoint && !endpoints.includes(endpoint)) endpoints.push(endpoint);
  }
  return endpoints;
};

export const modelEndpointsToPublicPaths = (endpoints: readonly ModelEndpoint[]): string[] => {
  const paths: string[] = [];
  for (const endpoint of endpoints) {
    if (endpoint === 'messages_count_tokens') continue;
    const path = modelEndpointToPublicPath(endpoint);
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
};

export const endpointsIncludeLlmGeneration = (endpoints: readonly ModelEndpoint[]): boolean =>
  endpoints.includes('messages') || endpoints.includes('responses') || endpoints.includes('chat_completions');
