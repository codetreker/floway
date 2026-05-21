// Generic OpenAI-compatible upstream — third-party providers that expose
// /v1/chat/completions, /v1/responses, /v1/embeddings, /v1/models with a
// static bearer token.
//
// The provider's base URL is stored without an API prefix (admin enters
// e.g. https://api.openai.com); we join it to a per-endpoint path. The
// default paths follow OpenAI's `/v1/*` layout, but admins can override
// individual endpoints to handle providers that mount the API under a
// subpath while still serving e.g. `/models` at the root.

import { joinBaseAndPath } from './join.ts';
import type { Upstream, UpstreamFetchOptions } from './types.ts';
import type { EndpointKey, UpstreamConfig } from '../../repo/types.ts';

const trimTrailingSlash = (s: string): string => s.replace(/\/+$/, '');

const OPENAI_DEFAULT_PATHS: Record<EndpointKey, string> = {
  chat_completions: '/v1/chat/completions',
  responses: '/v1/responses',
  messages: '/v1/messages',
  messages_count_tokens: '/v1/messages/count_tokens',
  embeddings: '/v1/embeddings',
  models: '/v1/models',
};

const resolveOpenAiPath = (config: UpstreamConfig, endpoint: EndpointKey): string => {
  // count_tokens is intentionally not independently overridable — it tracks
  // whatever path the admin chose for `messages` so the two stay in sync.
  if (endpoint === 'messages_count_tokens') {
    const messagesPath = config.pathOverrides?.messages ?? OPENAI_DEFAULT_PATHS.messages;
    return `${messagesPath}/count_tokens`;
  }
  return config.pathOverrides?.[endpoint] ?? OPENAI_DEFAULT_PATHS[endpoint];
};

export const createOpenAiUpstream = (config: UpstreamConfig): Upstream => {
  const baseUrl = trimTrailingSlash(config.baseUrl);
  return {
    id: config.id,
    name: config.name,
    kind: 'openai',
    supportedEndpoints: config.supportedEndpoints,
    enabledFixes: new Set(config.enabledFixes),
    fetch: async (endpoint, init: RequestInit, options?: UpstreamFetchOptions) => {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${config.bearerToken}`);
      if (init.body && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      if (options?.extraHeaders) {
        for (const [k, v] of Object.entries(options.extraHeaders)) {
          headers.set(k, v);
        }
      }
      const url = joinBaseAndPath(baseUrl, resolveOpenAiPath(config, endpoint));
      return await fetch(url, { ...init, headers });
    },
  };
};
