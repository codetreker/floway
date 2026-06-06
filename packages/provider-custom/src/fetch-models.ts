// Custom-upstream /models response parser. Permissively accepts the three
// shapes our `custom` provider needs to interoperate with:
//   1. OpenAI:       { object: 'list', data: [{ id, object?, owned_by?, created? }] }
//   2. Anthropic:    { data: [{ type: 'model', id, display_name?, created_at? }],
//                      has_more, first_id, last_id }     (no top-level `object`)
//   3. floway's own /models (superset of 1+2 with display_name,
//      created_at, limits, cost, kind).
//
// The parser is intentionally tolerant: a model is admitted if it has a string
// `id`; everything else is best-effort metadata. The container is admitted if
// `data` is an array. We do NOT read any per-model endpoint hint — endpoint
// routing for an auto custom model is inferred by the provider (Tier 1 reads
// the published `kind` here if the upstream emits it; Tier 2 falls back to an id
// heuristic; the chat default takes the per-upstream `endpoints` config).

import type { CustomUpstreamConfig } from './config.ts';
import { customFetchModels } from './fetch.ts';
import type { ModelKind, ModelPricing } from '@floway-dev/protocols/common';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';

export interface CustomRawModel {
  id: string;
  // OpenAI / our-gateway use `created` (unix seconds). Anthropic / our-gateway
  // also expose `created_at` (ISO-8601). We carry both and let the projection
  // step decide which to use.
  created?: number;
  created_at?: string;
  // OpenAI uses no display name. Anthropic / our-gateway use `display_name`.
  // Some OpenAI-compat upstreams use the non-standard `name`.
  display_name?: string;
  name?: string;
  owned_by?: string;
  // floway-only superset fields.
  limits?: {
    max_output_tokens?: number;
    max_context_window_tokens?: number;
    max_prompt_tokens?: number;
  };
  cost?: ModelPricing;
  // Tier 1 embedding-vs-chat signal: present when the upstream is another
  // floway and emits its own ModelKind. Other OpenAI-compat providers
  // (OpenAI, Anthropic, Groq, DeepSeek) never set this; the provider's id
  // heuristic (Tier 2) then takes over.
  kind?: ModelKind;
}

export interface CustomModelsResponse {
  data: CustomRawModel[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalNumberField = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const optionalStringField = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

const parseLimits = (value: unknown): CustomRawModel['limits'] => {
  if (!isRecord(value)) return undefined;
  const limits: NonNullable<CustomRawModel['limits']> = {};
  const max_output_tokens = optionalNumberField(value.max_output_tokens);
  if (max_output_tokens !== undefined) limits.max_output_tokens = max_output_tokens;
  const max_context_window_tokens = optionalNumberField(value.max_context_window_tokens);
  if (max_context_window_tokens !== undefined) limits.max_context_window_tokens = max_context_window_tokens;
  const max_prompt_tokens = optionalNumberField(value.max_prompt_tokens);
  if (max_prompt_tokens !== undefined) limits.max_prompt_tokens = max_prompt_tokens;
  return Object.keys(limits).length > 0 ? limits : undefined;
};

const PRICING_DIMENSIONS: readonly (keyof ModelPricing)[] = ['input', 'input_cache_read', 'input_cache_write', 'input_image', 'output', 'output_image'];

const parseCost = (value: unknown): ModelPricing | undefined => {
  // Admit any subset of billing dimensions advertised on the upstream's
  // /v1/models cost block; drop the whole block when none are present.
  if (!isRecord(value)) return undefined;
  const cost: ModelPricing = {};
  for (const dimension of PRICING_DIMENSIONS) {
    const rate = optionalNumberField(value[dimension]);
    if (rate !== undefined) cost[dimension] = rate;
  }
  return Object.keys(cost).length > 0 ? cost : undefined;
};

const parseKind = (value: unknown): ModelKind | undefined => {
  if (value === 'chat' || value === 'embedding' || value === 'image') return value;
  return undefined;
};

const parseRawModel = (value: unknown): CustomRawModel | null => {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || value.id === '') return null;
  const model: CustomRawModel = { id: value.id };
  const created = optionalNumberField(value.created);
  if (created !== undefined) model.created = created;
  const created_at = optionalStringField(value.created_at);
  if (created_at !== undefined) model.created_at = created_at;
  const display_name = optionalStringField(value.display_name);
  if (display_name !== undefined) model.display_name = display_name;
  const name = optionalStringField(value.name);
  if (name !== undefined) model.name = name;
  const owned_by = optionalStringField(value.owned_by);
  if (owned_by !== undefined) model.owned_by = owned_by;
  const limits = parseLimits(value.limits);
  if (limits !== undefined) model.limits = limits;
  const cost = parseCost(value.cost);
  if (cost !== undefined) model.cost = cost;
  const kind = parseKind(value.kind);
  if (kind !== undefined) model.kind = kind;
  return model;
};

const parseCustomModelsResponse = (value: unknown): CustomModelsResponse | null => {
  if (!isRecord(value) || !Array.isArray(value.data)) return null;
  const data: CustomRawModel[] = [];
  for (const item of value.data) {
    const model = parseRawModel(item);
    if (model) data.push(model);
  }
  return { data };
};

export const fetchCustomModels = async (config: CustomUpstreamConfig): Promise<CustomModelsResponse> => {
  let response: Response;
  try {
    response = await customFetchModels(config, { method: 'GET' });
  } catch (cause) {
    throw new ProviderModelsUnavailableError(null, cause);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new ProviderModelsUnavailableError({
      status: response.status,
      headers: new Headers(response.headers),
      body,
    });
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (cause) {
    throw new ProviderModelsUnavailableError(null, cause);
  }
  const result = parseCustomModelsResponse(parsed);
  if (!result) {
    throw new ProviderModelsUnavailableError(null, new Error('Invalid /models response shape'));
  }
  return result;
};
