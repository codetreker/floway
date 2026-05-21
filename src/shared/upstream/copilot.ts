// Copilot upstream adapter — wraps the existing copilotFetch + token exchange
// behind the generic Upstream interface. Reuses shared/copilot.ts so the token
// cache (in-process + KV) stays shared across all callers.

import type { EndpointKey } from '../../repo/types.ts';
import { copilotFetch, isCopilotTokenFetchError } from '../copilot.ts';
import type { Upstream, UpstreamFetchOptions } from './types.ts';

export interface CopilotUpstreamFetchOptions extends UpstreamFetchOptions {
  vision?: boolean;
  initiator?: 'user' | 'agent';
}

export interface CopilotUpstream extends Upstream {
  fetch(endpoint: EndpointKey, init: RequestInit, options?: CopilotUpstreamFetchOptions): Promise<Response>;
}

const COPILOT_UPSTREAM_ID = 'copilot';

// Copilot mounts its API at the host root and uses an Anthropic-style
// `/v1/messages` for the Messages endpoint while keeping `/chat/completions`,
// `/responses`, `/embeddings`, and `/models` un-prefixed. These paths are not
// admin-configurable: they reflect Copilot's own contract, not a deployment
// choice.
const COPILOT_PATHS: Record<EndpointKey, string> = {
  chat_completions: '/chat/completions',
  responses: '/responses',
  messages: '/v1/messages',
  messages_count_tokens: '/v1/messages/count_tokens',
  embeddings: '/embeddings',
  models: '/models',
};

export const COPILOT_SUPPORTED_ENDPOINTS = ['/chat/completions', '/responses', '/v1/messages', '/embeddings'];

// Encode the active token into the upstream id so the per-upstream models
// cache is invalidated when the GitHub account or accountType changes. The
// hash keeps the id stable across requests with the same credentials.
const tokenHash = async (token: string, accountType: string): Promise<string> => {
  const bytes = new TextEncoder().encode(`${accountType}:${token}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
};

export const createCopilotUpstream = async (githubToken: string, accountType: string): Promise<CopilotUpstream> => {
  const tag = await tokenHash(githubToken, accountType);
  return {
    id: `${COPILOT_UPSTREAM_ID}:${tag}`,
    name: 'GitHub Copilot',
    kind: 'copilot',
    supportedEndpoints: COPILOT_SUPPORTED_ENDPOINTS,
    // Admin's explicit opt-in set. Empty for Copilot: Copilot provider code
    // owns its default fixes and Copilot-only structural workarounds before
    // this low-level adapter sends the HTTP request.
    enabledFixes: new Set<string>(),
    fetch: async (endpoint, init, options?: CopilotUpstreamFetchOptions) => {
      try {
        return await copilotFetch(COPILOT_PATHS[endpoint], init, githubToken, accountType, options);
      } catch (error) {
        if (!isCopilotTokenFetchError(error)) throw error;
        return new Response(error.body, {
          status: error.status,
          headers: new Headers(error.headers),
        });
      }
    },
  };
};

export { COPILOT_UPSTREAM_ID };
