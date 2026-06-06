import type { CustomUpstreamConfig } from './config.ts';
import { type UpstreamFetchOptions, joinBaseAndPath } from '@floway-dev/provider';

const ANTHROPIC_VERSION = '2023-06-01';

const trimTrailingSlash = (s: string): string => s.replace(/\/+$/, '');

// Per-endpoint default paths. Admin pathOverrides (see config.ts) replace
// these one-for-one; messages_count_tokens / responses_compact track the
// override of their parent endpoint (suffix appended).
const CUSTOM_DEFAULT_PATHS = {
  chat_completions: '/v1/chat/completions',
  responses: '/v1/responses',
  messages: '/v1/messages',
  embeddings: '/v1/embeddings',
  images_generations: '/v1/images/generations',
  images_edits: '/v1/images/edits',
} as const;

// Internal: parent path for a logical endpoint, honouring admin overrides.
const resolveOverridable = (config: CustomUpstreamConfig, key: keyof typeof CUSTOM_DEFAULT_PATHS): string =>
  config.pathOverrides?.[key] ?? CUSTOM_DEFAULT_PATHS[key];

// Private base dispatcher: applies the configured auth header per authStyle,
// JSON Content-Type when carrying a body, plus any extra headers.
const customFetchInternal = async (
  config: CustomUpstreamConfig,
  path: string,
  init: RequestInit,
  options?: UpstreamFetchOptions,
): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (config.authStyle === 'anthropic') {
    headers.set('x-api-key', config.bearerToken);
    if (!headers.has('anthropic-version')) headers.set('anthropic-version', ANTHROPIC_VERSION);
  } else {
    headers.set('Authorization', `Bearer ${config.bearerToken}`);
  }
  if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (options?.extraHeaders) {
    for (const [k, v] of Object.entries(options.extraHeaders)) headers.set(k, v);
  }
  return await fetch(joinBaseAndPath(trimTrailingSlash(config.baseUrl), path), { ...init, headers });
};

// Typed transports — one per logical endpoint Custom serves. count_tokens /
// responses_compact derive their path by suffixing the (possibly admin-
// overridden) parent endpoint, so renaming `messages` to `/custom/messages`
// implicitly moves `messages/count_tokens` to `/custom/messages/count_tokens`.
export const customFetchChatCompletions = (config: CustomUpstreamConfig, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, resolveOverridable(config, 'chat_completions'), init, options);
export const customFetchResponses = (config: CustomUpstreamConfig, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, resolveOverridable(config, 'responses'), init, options);
export const customFetchResponsesCompact = (config: CustomUpstreamConfig, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, `${resolveOverridable(config, 'responses')}/compact`, init, options);
export const customFetchMessages = (config: CustomUpstreamConfig, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, resolveOverridable(config, 'messages'), init, options);
export const customFetchMessagesCountTokens = (config: CustomUpstreamConfig, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, `${resolveOverridable(config, 'messages')}/count_tokens`, init, options);
export const customFetchEmbeddings = (config: CustomUpstreamConfig, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, resolveOverridable(config, 'embeddings'), init, options);
export const customFetchImagesGenerations = (config: CustomUpstreamConfig, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, resolveOverridable(config, 'images_generations'), init, options);
export const customFetchImagesEdits = (config: CustomUpstreamConfig, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, resolveOverridable(config, 'images_edits'), init, options);
// /models lives on its own fetch toggle (see config.modelsFetch.endpoint),
// not in pathOverrides.
export const customFetchModels = (config: CustomUpstreamConfig, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, config.modelsFetch.endpoint ?? '/v1/models', init, options);
