import { type AzureUpstreamConfig, isFoundryProjectRootPath, trimTrailingSlash } from './config.ts';
import { type UpstreamFetchOptions, joinBaseAndPath } from '@floway-dev/provider';

const azureOpenAiV1BaseUrl = (endpoint: string): string => {
  const url = new URL(trimTrailingSlash(endpoint));
  const path = trimTrailingSlash(url.pathname);
  if (path.endsWith('/openai/v1')) {
    url.pathname = path;
  } else if (path === '/anthropic/v1/messages' || path === '/anthropic/v1' || path === '/anthropic') {
    url.pathname = '/openai/v1';
  } else if (isFoundryProjectRootPath(path)) {
    url.pathname = `${path}/openai/v1`;
  } else {
    url.pathname = '/openai/v1';
  }
  return trimTrailingSlash(url.href);
};

const withAzureFoundryServicesHost = (url: URL): URL => {
  const next = new URL(url.href);
  if (next.hostname.endsWith('.openai.azure.com')) {
    next.hostname = `${next.hostname.slice(0, -'.openai.azure.com'.length)}.services.ai.azure.com`;
  }
  return next;
};

const azureAnthropicBaseUrl = (endpoint: string): string => {
  const url = withAzureFoundryServicesHost(new URL(trimTrailingSlash(endpoint)));
  const path = trimTrailingSlash(url.pathname);
  if (path === '/anthropic/v1/messages') {
    url.pathname = path.slice(0, -'/v1/messages'.length);
  } else if (path === '/anthropic/v1') {
    url.pathname = path.slice(0, -3);
  } else if (path === '/anthropic') {
    url.pathname = path;
  } else {
    url.pathname = '/anthropic';
  }
  return trimTrailingSlash(url.href);
};

// Private base dispatcher: applies the right credential header per surface
// (api-key for OpenAI v1, x-api-key + anthropic-version for /anthropic),
// JSON Content-Type when carrying a body, plus any extra headers, then
// resolves URL on the per-surface base.
const azureFetchInternal = async (
  config: AzureUpstreamConfig,
  surface: 'openai' | 'anthropic',
  path: string,
  init: RequestInit,
  options?: UpstreamFetchOptions,
  query?: string,
): Promise<Response> => {
  const baseUrl = surface === 'openai' ? azureOpenAiV1BaseUrl(config.endpoint) : azureAnthropicBaseUrl(config.endpoint);
  const headers = new Headers(init.headers);
  if (surface === 'anthropic') {
    headers.set('x-api-key', config.apiKey);
    headers.set('anthropic-version', '2023-06-01');
  } else {
    headers.set('api-key', config.apiKey);
  }
  if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (options?.extraHeaders) {
    for (const [key, value] of Object.entries(options.extraHeaders)) headers.set(key, value);
  }
  const url = joinBaseAndPath(baseUrl, path);
  if (!query) return await fetch(url, { ...init, headers });
  // Append per-endpoint query through URL.searchParams so a future path
  // that itself carries a query suffix does not produce `path?a?b`.
  const parsed = new URL(url);
  for (const [key, value] of new URLSearchParams(query).entries()) parsed.searchParams.append(key, value);
  return await fetch(parsed.href, { ...init, headers });
};

// Typed transports — one per logical endpoint Azure serves. Streaming and
// non-streaming alike return a raw Response; per-endpoint return-type
// wrapping (event stream parse, compaction envelope parse) lives in the
// provider call methods that consume these.
export const azureFetchChatCompletions = (config: AzureUpstreamConfig, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response> =>
  azureFetchInternal(config, 'openai', '/chat/completions', init, options);
export const azureFetchResponses = (config: AzureUpstreamConfig, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response> =>
  azureFetchInternal(config, 'openai', '/responses', init, options);
export const azureFetchResponsesCompact = (config: AzureUpstreamConfig, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response> =>
  azureFetchInternal(config, 'openai', '/responses/compact', init, options);
export const azureFetchEmbeddings = (config: AzureUpstreamConfig, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response> =>
  azureFetchInternal(config, 'openai', '/embeddings', init, options);
// gpt-image-2 (released 2026-04-21) and the gpt-image-1 family are exposed
// only under Azure's preview lifecycle today. We will drop the query suffix
// once Azure promotes the image endpoints to the GA default.
export const azureFetchImagesGenerations = (config: AzureUpstreamConfig, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response> =>
  azureFetchInternal(config, 'openai', '/images/generations', init, options, 'api-version=preview');
export const azureFetchImagesEdits = (config: AzureUpstreamConfig, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response> =>
  azureFetchInternal(config, 'openai', '/images/edits', init, options, 'api-version=preview');
export const azureFetchModels = (config: AzureUpstreamConfig, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response> =>
  azureFetchInternal(config, 'openai', '/models', init, options);
export const azureFetchMessages = (config: AzureUpstreamConfig, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response> =>
  azureFetchInternal(config, 'anthropic', '/v1/messages', init, options);
export const azureFetchMessagesCountTokens = (config: AzureUpstreamConfig, init: RequestInit, options?: UpstreamFetchOptions): Promise<Response> =>
  azureFetchInternal(config, 'anthropic', '/v1/messages/count_tokens', init, options);
