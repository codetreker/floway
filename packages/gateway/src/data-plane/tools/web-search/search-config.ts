import type { SearchConfig } from './types.ts';
import { getRepo } from '../../../repo/index.ts';
import { isJsonObject } from '../../../shared/json-helpers.ts';
import { WEB_SEARCH_PROVIDER_NAMES, isWebSearchProviderName } from '../../../shared/web-search-providers.ts';

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  provider: 'disabled',
  tavily: { apiKey: '' },
  microsoftGrounding: { apiKey: '' },
  jina: { apiKey: '' },
};

export const FIXED_SEARCH_CONFIG_TEST_QUERY = 'React documentation';

// Returns a fresh deep copy so callers can mutate without corrupting
// the module-scoped singleton.
export const parseSearchConfigDefault = (): SearchConfig => structuredClone(DEFAULT_SEARCH_CONFIG);

// Strict parse: throws on malformed shape so persistence corruption
// surfaces instead of silently downgrading to `disabled`.
export const parseSearchConfigStrict = (input: unknown): SearchConfig => {
  if (!isJsonObject(input)) {
    throw new Error('search config must be a JSON object');
  }
  if (input.provider !== 'disabled' && !isWebSearchProviderName(input.provider)) {
    const allowed = ['disabled', ...WEB_SEARCH_PROVIDER_NAMES].map(name => `'${name}'`).join(', ');
    throw new Error(`search config provider must be one of ${allowed}, got ${JSON.stringify(input.provider)}`);
  }
  if (!isJsonObject(input.tavily)) {
    throw new Error('search config tavily must be an object');
  }
  if (typeof input.tavily.apiKey !== 'string') {
    throw new Error('search config tavily.apiKey must be a string');
  }
  if (!isJsonObject(input.microsoftGrounding)) {
    throw new Error('search config microsoftGrounding must be an object');
  }
  if (typeof input.microsoftGrounding.apiKey !== 'string') {
    throw new Error('search config microsoftGrounding.apiKey must be a string');
  }
  if (!isJsonObject(input.jina)) {
    throw new Error('search config jina must be an object');
  }
  if (typeof input.jina.apiKey !== 'string') {
    throw new Error('search config jina.apiKey must be a string');
  }
  return {
    provider: input.provider,
    tavily: { apiKey: input.tavily.apiKey.trim() },
    microsoftGrounding: { apiKey: input.microsoftGrounding.apiKey.trim() },
    jina: { apiKey: input.jina.apiKey.trim() },
  };
};

// Lossy normalize: coerces any unknown into a SearchConfig, defaulting
// missing or malformed fields to the disabled/empty shape. Used by
// zod-validated input paths where the schema already enforced the
// outer shape; the normalizer just guarantees the canonical form
// (trimmed strings, fields always present).
export const normalizeSearchConfig = (input: unknown): SearchConfig => {
  const record = isJsonObject(input) ? input : {};
  const tavily = isJsonObject(record.tavily) ? record.tavily : {};
  const microsoftGrounding = isJsonObject(record.microsoftGrounding) ? record.microsoftGrounding : {};
  const jina = isJsonObject(record.jina) ? record.jina : {};

  return {
    provider: isWebSearchProviderName(record.provider) ? record.provider : 'disabled',
    tavily: { apiKey: typeof tavily.apiKey === 'string' ? tavily.apiKey.trim() : '' },
    microsoftGrounding: { apiKey: typeof microsoftGrounding.apiKey === 'string' ? microsoftGrounding.apiKey.trim() : '' },
    jina: { apiKey: typeof jina.apiKey === 'string' ? jina.apiKey.trim() : '' },
  };
};

export const loadSearchConfig = async (): Promise<SearchConfig> => {
  const stored = await getRepo().searchConfig.get();
  if (stored === null) return parseSearchConfigDefault();
  return parseSearchConfigStrict(stored);
};

export const saveSearchConfig = async (config: unknown): Promise<SearchConfig> => {
  const parsed = parseSearchConfigStrict(config);
  await getRepo().searchConfig.save(parsed);
  return parsed;
};
