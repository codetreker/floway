import { isKnownFlagId } from '../../data-plane/providers/flags.ts';
import type { ModelKind, ModelPricing } from '@floway-dev/protocols/common';

export interface UpstreamModelLimits {
  max_context_window_tokens?: number;
  max_prompt_tokens?: number;
  max_output_tokens?: number;
}

export interface UpstreamModelFlagOverrides {
  enabled: boolean;
  values: Record<string, boolean>;
}

export interface UpstreamModelConfig {
  upstreamModelId: string;
  publicModelId?: string;
  // Required metadata mirroring our public model definition. Routing is still
  // driven by supportedEndpoints (kept consistent with kind by the editor);
  // kind decides which fields the dashboard form surfaces. Derived from the
  // endpoints when an entry omits it.
  kind: ModelKind;
  supportedEndpoints: string[];
  display_name?: string;
  limits?: UpstreamModelLimits;
  cost?: ModelPricing;
  flagOverrides?: UpstreamModelFlagOverrides;
}

// The public catalog id a model is exposed under: an explicit override when set,
// otherwise the upstream id itself.
export const publicModelId = (model: UpstreamModelConfig): string => {
  const configured = model.publicModelId?.trim();
  return configured && configured.length > 0 ? configured : model.upstreamModelId;
};

// The accepted per-model endpoint path set. Azure exposes OpenAI v1 and
// Anthropic deployment paths; custom upstreams pass their per-model
// endpoints through the same validator and legitimately use the same paths
// (`/chat/completions`, `/responses`, `/v1/messages`, ...), so this is the
// shared set both providers validate against.
export const OPENAI_MODEL_ENDPOINT_PATHS = new Set([
  '/chat/completions', '/v1/chat/completions',
  '/responses', '/v1/responses',
  '/embeddings', '/v1/embeddings',
  '/images/generations', '/v1/images/generations',
  '/images/edits', '/v1/images/edits',
]);
export const ANTHROPIC_MODEL_ENDPOINT_PATHS = new Set(['/v1/messages', '/messages']);
const SUPPORTED_ENDPOINT_PATHS = new Set([...OPENAI_MODEL_ENDPOINT_PATHS, ...ANTHROPIC_MODEL_ENDPOINT_PATHS]);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const nonEmptyStringField = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Malformed ${label}: must be a non-empty string`);
  return value;
};

export const optionalStringField = (value: unknown, label: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Malformed ${label}: must be a string`);
  return value;
};

export const supportedEndpointsField = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Malformed ${label}: must be a non-empty string array`);
  }

  const endpoints: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`Malformed ${label}: must be a non-empty string array`);
    if (!SUPPORTED_ENDPOINT_PATHS.has(item)) {
      throw new Error(`Malformed ${label}: unsupported entry ${item}`);
    }
    if (!endpoints.includes(item)) endpoints.push(item);
  }
  return endpoints;
};

const optionalNumberField = (value: unknown, label: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Malformed ${label}: must be a finite number`);
  return value;
};

const optionalMetadataRecord = (value: unknown, label: string): Record<string, unknown> | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Malformed ${label}: must be an object`);
  return value;
};

export const limitsField = (value: unknown, label: string): UpstreamModelLimits | undefined => {
  const record = optionalMetadataRecord(value, label);
  if (!record) return undefined;
  return {
    ...(record.max_context_window_tokens !== undefined ? { max_context_window_tokens: optionalNumberField(record.max_context_window_tokens, `${label}.max_context_window_tokens`) } : {}),
    ...(record.max_prompt_tokens !== undefined ? { max_prompt_tokens: optionalNumberField(record.max_prompt_tokens, `${label}.max_prompt_tokens`) } : {}),
    ...(record.max_output_tokens !== undefined ? { max_output_tokens: optionalNumberField(record.max_output_tokens, `${label}.max_output_tokens`) } : {}),
  };
};

export const flagOverridesField = (value: unknown, label: string): UpstreamModelFlagOverrides | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Malformed ${label}: must be an object`);
  if (typeof value.enabled !== 'boolean') throw new Error(`Malformed ${label}.enabled: must be a boolean`);
  if (!isRecord(value.values)) throw new Error(`Malformed ${label}.values: must be an object`);
  const unknown: string[] = [];
  const values: Record<string, boolean> = {};
  for (const [id, on] of Object.entries(value.values)) {
    if (typeof on !== 'boolean') throw new Error(`Malformed ${label}.values.${id}: must be a boolean`);
    if (!isKnownFlagId(id)) {
      unknown.push(id);
      continue;
    }
    values[id] = on;
  }
  if (unknown.length > 0) {
    throw new Error(`Malformed ${label}.values: unknown flag ids: ${unknown.join(', ')}`);
  }
  return { enabled: value.enabled, values };
};

const nonNegativeNumberField = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Malformed ${label}: must be a finite non-negative number`);
  }
  return value;
};

const PRICING_DIMENSIONS: readonly (keyof ModelPricing)[] = ['input', 'input_cache_read', 'input_cache_write', 'input_image', 'output', 'output_image'];

export const pricingField = (value: unknown, label: string): ModelPricing | undefined => {
  const record = optionalMetadataRecord(value, label);
  if (!record) return undefined;
  const pricing: ModelPricing = {};
  for (const dimension of PRICING_DIMENSIONS) {
    if (record[dimension] !== undefined) pricing[dimension] = nonNegativeNumberField(record[dimension], `${label}.${dimension}`);
  }
  return Object.keys(pricing).length > 0 ? pricing : undefined;
};

const MODEL_KINDS: ReadonlySet<ModelKind> = new Set<ModelKind>(['chat', 'embedding', 'image']);

// kind is a pure function of the routing endpoints, so an entry that omits it
// (an older row, or an import) derives one rather than failing. The editor
// always writes an explicit kind, keeping it consistent with the endpoints.
const kindFromEndpoints = (endpoints: readonly string[]): ModelKind => {
  if (endpoints.some(e => e === '/embeddings' || e === '/v1/embeddings')) return 'embedding';
  if (endpoints.some(e => e.includes('/images/'))) return 'image';
  return 'chat';
};

const kindField = (value: unknown, endpoints: readonly string[], label: string): ModelKind => {
  if (value === undefined) return kindFromEndpoints(endpoints);
  if (typeof value !== 'string' || !MODEL_KINDS.has(value as ModelKind)) {
    throw new Error(`Malformed ${label}: must be one of chat, embedding, image`);
  }
  return value as ModelKind;
};

const modelField = (value: unknown, label: string): UpstreamModelConfig => {
  if (!isRecord(value)) throw new Error(`Malformed ${label}: must be an object`);
  const cost = pricingField(value.cost, `${label}.cost`);
  const supportedEndpoints = supportedEndpointsField(value.supportedEndpoints, `${label}.supportedEndpoints`);
  return {
    upstreamModelId: nonEmptyStringField(value.upstreamModelId, `${label}.upstreamModelId`),
    ...(value.publicModelId !== undefined ? { publicModelId: optionalStringField(value.publicModelId, `${label}.publicModelId`) } : {}),
    kind: kindField(value.kind, supportedEndpoints, `${label}.kind`),
    supportedEndpoints,
    ...(value.display_name !== undefined ? { display_name: optionalStringField(value.display_name, `${label}.display_name`) } : {}),
    ...(value.limits !== undefined ? { limits: limitsField(value.limits, `${label}.limits`) } : {}),
    ...(cost ? { cost } : {}),
    ...(value.flagOverrides !== undefined ? { flagOverrides: flagOverridesField(value.flagOverrides, `${label}.flagOverrides`) } : {}),
  };
};

export const modelsField = (value: unknown, providerLabel: string): UpstreamModelConfig[] => {
  if (!Array.isArray(value)) throw new Error(`Malformed ${providerLabel} upstream config: models must be an array`);
  return value.map((entry, i) => modelField(entry, `${providerLabel} models[${i}]`));
};
