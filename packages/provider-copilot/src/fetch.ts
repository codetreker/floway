// Copilot upstream transport. Maps each logical endpoint to the path
// Copilot serves it on, then dispatches through the authed fetch.

import { copilotAuthedFetch, isCopilotTokenFetchError } from './auth.ts';
import type { CopilotUpstreamConfig } from './config.ts';
import type { UpstreamFetchOptions } from '@floway-dev/provider';

// Copilot mounts its API at the host root and uses an Anthropic-style
// `/v1/messages` for the Messages endpoint while keeping `/chat/completions`,
// `/responses`, `/embeddings`, `/images/*`, and `/models` un-prefixed. These
// paths reflect Copilot's contract and are not admin-configurable.

// Subset of the persisted copilot upstream record's config the transport needs;
// `user` is irrelevant on the wire, so the parameter type only names the auth
// fields. Any CopilotUpstreamConfig satisfies it structurally.
type CopilotFetchConfig = Pick<CopilotUpstreamConfig, 'githubToken' | 'accountType'>;

// Convert a CopilotTokenFetchError into a regular Response so callers treat
// token-exchange failures like any other 4xx/5xx.
const copilotFetchInternal = async (
  config: CopilotFetchConfig,
  path: string,
  init: RequestInit,
  options: UpstreamFetchOptions,
): Promise<Response> => {
  try {
    return await copilotAuthedFetch(path, init, config.githubToken, config.accountType, {
      headers: options.extraHeaders,
      fetcher: options.fetcher,
      ...(options.recordUpstreamLatency ? { recordUpstreamLatency: options.recordUpstreamLatency } : {}),
    });
  } catch (error) {
    if (!isCopilotTokenFetchError(error)) throw error;
    return new Response(error.body, {
      status: error.status,
      headers: new Headers(error.headers),
    });
  }
};

export const copilotFetchChatCompletions = (config: CopilotFetchConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/chat/completions', init, options);
export const copilotFetchResponses = (config: CopilotFetchConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/responses', init, options);
export const copilotFetchMessages = (config: CopilotFetchConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/v1/messages', init, options);
export const copilotFetchMessagesCountTokens = (config: CopilotFetchConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/v1/messages/count_tokens', init, options);
export const copilotFetchEmbeddings = (config: CopilotFetchConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/embeddings', init, options);
export const copilotFetchModels = (config: CopilotFetchConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  copilotFetchInternal(config, '/models', init, options);
