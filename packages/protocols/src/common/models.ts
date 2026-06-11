// Disjoint billing dimensions a single request can be charged on. Every count
// keyed by these is non-overlapping: a prompt token is counted under exactly
// one of `input`, `input_cache_read`, `input_cache_write`, or `input_image`,
// never several at once.
//
// Convention borrowed from models.dev and LiteLLM: bare `input`/`output` mean
// the text modality AND act as the fallback rate for any modality without a
// dedicated rate; the `_image` variants are the image modality. There are no
// image cache dimensions on purpose — a live probe of Azure gpt-image-2
// confirmed its usage object never emits cached fields.
export type BillingDimension = 'input' | 'input_cache_read' | 'input_cache_write' | 'input_image' | 'output' | 'output_image';

// Iteration form of BillingDimension; the type union is the source of truth.
export const BILLING_DIMENSIONS: readonly BillingDimension[] = ['input', 'input_cache_read', 'input_cache_write', 'input_image', 'output', 'output_image'];

// Per-model pricing in USD per million tokens, aligned with the sst/models.dev
// `Cost` schema (https://github.com/sst/models.dev/blob/main/packages/core/src/schema.ts).
// Keys are billing dimensions: bare `input`/`output` are the text/fallback rate
// and `_image` keys are the image modality. Every key is optional; an absent key
// falls back per `unitPriceForDimension` (modality → bare, cached → uncached).
export type ModelPricing = Partial<Record<BillingDimension, number>>;

// Resolve the USD-per-million-tokens unit price for one dimension against a
// pricing snapshot, applying the LiteLLM-style fallback chain: a modality with
// no dedicated rate falls back to the bare text rate, and cached input falls
// back to uncached input. Returns null when even the fallback base is absent
// (or the whole snapshot is null), which aggregation treats as cost 0.
export const unitPriceForDimension = (pricing: ModelPricing | null, dimension: BillingDimension): number | null => {
  if (!pricing) return null;
  switch (dimension) {
  case 'input':
    return pricing.input ?? null;
  case 'input_cache_read':
    return pricing.input_cache_read ?? pricing.input ?? null;
  case 'input_cache_write':
    return pricing.input_cache_write ?? pricing.input ?? null;
  case 'input_image':
    return pricing.input_image ?? pricing.input ?? null;
  case 'output':
    return pricing.output ?? null;
  case 'output_image':
    return pricing.output_image ?? pricing.output ?? null;
  }
};

// High-level endpoint-family discriminator. A model belongs to exactly one
// kind; cross-cutting features (vision, function calling, structured
// outputs) are orthogonal and modeled separately when needed.
//
// Convention borrowed from Together AI's `type` field on /v1/models, which
// chooses a single string enum because each model id in practice maps to
// one endpoint family. Field is named `kind` rather than `type` because
// PublicModel already carries Anthropic's `type: 'model'` discriminator.
//
// Add a value here only when we actually route that endpoint family — do
// not pre-declare for future capabilities.
export type ModelKind = 'chat' | 'embedding' | 'image';

// Public DTO served at /v1/models and /models. Single superset shape — OpenAI's
// and Anthropic's /models field names do not overlap, so one payload satisfies
// both client shapes.
export interface PublicModel {
  // OpenAI fields
  id: string;
  object: 'model';
  owned_by?: string;
  created?: number;
  // Anthropic fields
  type: 'model';
  display_name: string;
  created_at?: string;
  // Non-standard extra fields below.
  limits: {
    max_output_tokens?: number;
    max_context_window_tokens?: number;
    max_prompt_tokens?: number;
  };
  kind: ModelKind;
  cost?: ModelPricing;
}

export interface PublicModelsResponse {
  // OpenAI container
  object: 'list';
  // Anthropic container
  has_more: false;
  first_id: string | null;
  last_id: string | null;
  data: PublicModel[];
}
