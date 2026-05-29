import { joinBaseAndPath } from './join.ts';
import { ANTHROPIC_MODEL_ENDPOINT_PATHS, isRecord, modelsField, nonEmptyStringField, OPENAI_MODEL_ENDPOINT_PATHS, type UpstreamModelConfig } from './model-config.ts';
import type { EndpointKey, Upstream, UpstreamFetchOptions } from './types.ts';
import type { UpstreamRecord } from '../../repo/types.ts';

export interface AzureUpstreamConfig {
  endpoint: string;
  apiKey: string;
  models: UpstreamModelConfig[];
}

type AzureUpstreamRecord = UpstreamRecord & {
  provider: 'azure';
  config: AzureUpstreamConfig;
};

const AZURE_OPENAI_PATHS: Partial<Record<EndpointKey, string>> = {
  chat_completions: '/chat/completions',
  responses: '/responses',
  embeddings: '/embeddings',
  models: '/models',
  images_generations: '/images/generations',
  images_edits: '/images/edits',
};

// Per-endpoint query suffix appended to the resolved request URL. Image
// endpoints on Azure's /openai/v1 surface currently require
// ?api-version=preview because gpt-image-2 (released 2026-04-21) and the
// gpt-image-1 family are exposed only under the preview lifecycle. We will
// drop this entry once Azure promotes the image endpoints to the GA default.
const AZURE_OPENAI_QUERY: Partial<Record<EndpointKey, string>> = {
  images_generations: 'api-version=preview',
  images_edits: 'api-version=preview',
};

const AZURE_ANTHROPIC_PATHS: Partial<Record<EndpointKey, string>> = {
  messages: '/v1/messages',
  messages_count_tokens: '/v1/messages/count_tokens',
};

const AZURE_ENDPOINT_HOST_SUFFIXES = ['.openai.azure.com', '.services.ai.azure.com'];

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const isFoundryProjectRootPath = (path: string): boolean => /^\/api\/projects\/[^/]+$/.test(path);

const isAnthropicBasePath = (path: string): boolean => path === '/anthropic' || path === '/anthropic/v1' || path === '/anthropic/v1/messages';

const isAzureEndpointHost = (hostname: string): boolean =>
  AZURE_ENDPOINT_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix) && hostname.length > suffix.length);

// All azure-local field validators take the same fully-qualified label
// (`azure upstream config: <field>`) the shared model-config helpers expect,
// so every message reads `Malformed azure upstream config: <field>: <reason>`.
const optionalHttpUrlField = (value: unknown, label: string): string | undefined => {
  if (value === undefined) return undefined;
  const url = trimTrailingSlash(nonEmptyStringField(value, label).trim());
  if (url.includes('?') || url.includes('#')) {
    throw new Error(`Malformed ${label}: must be an http(s) URL without query or fragment`);
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('invalid protocol');
    }
    if (parsed.search || parsed.hash) {
      throw new Error('query or fragment');
    }
  } catch {
    throw new Error(`Malformed ${label}: must be an http(s) URL without query or fragment`);
  }
  return url;
};

const azureEndpointField = (value: unknown, label: string): string => {
  const url = optionalHttpUrlField(value, label);
  if (!url) throw new Error(`Malformed ${label}: is required`);
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !isAzureEndpointHost(parsed.hostname)) {
    throw new Error(`Malformed ${label}: must be an https Azure URL on *.openai.azure.com or *.services.ai.azure.com`);
  }

  const path = trimTrailingSlash(parsed.pathname);
  if (path !== '' && !isFoundryProjectRootPath(path) && !path.endsWith('/openai/v1') && !isAnthropicBasePath(path)) {
    throw new Error(`Malformed ${label}: must be an Azure resource root, a Foundry project endpoint, an OpenAI v1 URL ending in /openai/v1, an /anthropic URL, an /anthropic/v1 URL, or an /anthropic/v1/messages URL`);
  }
  return url;
};

const modelsUseAnyEndpoint = (models: readonly UpstreamModelConfig[], endpoints: ReadonlySet<string>): boolean =>
  models.some(model => model.supportedEndpoints.some(endpoint => endpoints.has(endpoint)));

const validateEndpointCoverage = (config: AzureUpstreamConfig): void => {
  const usesOpenAi = modelsUseAnyEndpoint(config.models, OPENAI_MODEL_ENDPOINT_PATHS);
  const usesAnthropic = modelsUseAnyEndpoint(config.models, ANTHROPIC_MODEL_ENDPOINT_PATHS);

  if (!usesOpenAi && !usesAnthropic) {
    throw new Error('Malformed azure upstream config: models must declare at least one OpenAI v1 or Anthropic endpoint');
  }
};

export const assertAzureUpstreamRecord = (record: UpstreamRecord): AzureUpstreamRecord => {
  if (record.provider !== 'azure') throw new Error(`Expected azure upstream record, got ${record.provider}`);
  if (!isRecord(record.config)) throw new Error('Malformed azure upstream config: config must be an object');

  const models = modelsField(record.config.models, 'azure');
  if (models.length === 0) throw new Error('Malformed azure upstream config: models must be a non-empty array');

  const config: AzureUpstreamConfig = {
    endpoint: azureEndpointField(record.config.endpoint, 'azure upstream config: endpoint'),
    apiKey: nonEmptyStringField(record.config.apiKey, 'azure upstream config: apiKey'),
    models,
  };
  validateEndpointCoverage(config);

  return {
    ...record,
    provider: 'azure',
    config,
  };
};

const configuredSupportedEndpoints = (config: AzureUpstreamConfig): string[] => {
  const endpoints: string[] = [];
  for (const model of config.models) {
    for (const endpoint of model.supportedEndpoints) {
      if (!endpoints.includes(endpoint)) endpoints.push(endpoint);
    }
  }
  return endpoints;
};

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

const requestUrl = (openAiBaseUrl: string | undefined, anthropicBaseUrl: string | undefined, endpoint: EndpointKey): string => {
  const openAiPath = AZURE_OPENAI_PATHS[endpoint];
  if (openAiPath) {
    if (!openAiBaseUrl) throw new Error('Azure upstream config does not include an OpenAI v1 endpoint');
    const url = joinBaseAndPath(openAiBaseUrl, openAiPath);
    const query = AZURE_OPENAI_QUERY[endpoint];
    if (!query) return url;
    // Append per-endpoint query through URL.searchParams so a future path
    // that itself carries a query suffix does not produce `path?a?b`.
    // AZURE_OPENAI_QUERY stores already-encoded pairs (e.g. `api-version=
    // preview`); parsing-then-appending preserves their encoding.
    const parsed = new URL(url);
    for (const [key, value] of new URLSearchParams(query).entries()) {
      parsed.searchParams.append(key, value);
    }
    return parsed.href;
  }

  const anthropicPath = AZURE_ANTHROPIC_PATHS[endpoint];
  if (anthropicPath) {
    if (!anthropicBaseUrl) throw new Error('Azure upstream config does not include an Anthropic endpoint');
    return joinBaseAndPath(anthropicBaseUrl, anthropicPath);
  }

  throw new Error(`Unsupported Azure upstream endpoint ${endpoint}`);
};

const isAnthropicEndpoint = (endpoint: EndpointKey): boolean => endpoint === 'messages' || endpoint === 'messages_count_tokens';

export const createAzureUpstream = (record: UpstreamRecord): Upstream => {
  const { config } = assertAzureUpstreamRecord(record);
  const openAiBaseUrl = azureOpenAiV1BaseUrl(config.endpoint);
  const anthropicBaseUrl = azureAnthropicBaseUrl(config.endpoint);
  return {
    id: record.id,
    name: record.name,
    kind: 'azure',
    supportedEndpoints: configuredSupportedEndpoints(config),
    fetch: async (endpoint, init: RequestInit, options?: UpstreamFetchOptions) => {
      const headers = new Headers(init.headers);
      if (isAnthropicEndpoint(endpoint)) {
        headers.set('x-api-key', config.apiKey);
        headers.set('anthropic-version', '2023-06-01');
      } else {
        headers.set('api-key', config.apiKey);
      }
      if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
        headers.set('Content-Type', 'application/json');
      }
      if (options?.extraHeaders) {
        for (const [key, value] of Object.entries(options.extraHeaders)) {
          headers.set(key, value);
        }
      }
      return await fetch(requestUrl(openAiBaseUrl, anthropicBaseUrl, endpoint), { ...init, headers });
    },
  };
};
