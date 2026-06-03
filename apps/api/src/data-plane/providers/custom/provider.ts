import { fetchCustomModels, type CustomModelsResponse, type CustomRawModel } from './fetch-models.ts';
import { inferEndpointsFromModelId } from './infer-endpoints.ts';
import type { UpstreamRecord } from '../../../repo/types.ts';
import { assertCustomUpstreamRecord, createCustomUpstream } from '../../../shared/upstream/custom.ts';
import { publicModelId } from '../../../shared/upstream/model-config.ts';
import type { EndpointKey } from '../../../shared/upstream/types.ts';
import { mergeAnthropicBetaHeader } from '../anthropic-beta.ts';
import { isStreamingEndpoint } from '../endpoints.ts';
import { resolveEffectiveFlags } from '../flags-resolve.ts';
import { defaultsForProvider } from '../flags.ts';
import { inProcessMemo, isProviderModelsHttpStatus, readModelsStore, writeModelsStore } from '../models-store.ts';
import type { ModelProvider, ModelProviderInstance, ProviderCallResult, UpstreamModel } from '../types.ts';
import { type ModelEndpoints, type ModelPricing, kindForEndpoints } from '@floway-dev/protocols/common';

interface CustomProviderData {
  rawModelId: string;
}

interface CustomModelsBlob {
  response: CustomModelsResponse;
  fetchedAt: number;
}

const SOFT_MS = 10 * 60 * 1000;
const HARD_MS = 2 * 60 * 60 * 1000;
const L1_TTL_MS = 120_000;
const providerData = (model: UpstreamModel): CustomProviderData => model.providerData as CustomProviderData;

// Projects a raw custom model into the slim provider-neutral fields; the
// caller adds kind / endpoints / providerData / enabledFlags. Display metadata
// (display_name / created) and `cost` pass through to the public catalog when
// the upstream chose to publish them.
const customInternalModel = (model: CustomRawModel): Omit<UpstreamModel, 'kind' | 'endpoints' | 'providerData' | 'enabledFlags'> => {
  const internal: Omit<UpstreamModel, 'kind' | 'endpoints' | 'providerData' | 'enabledFlags'> = {
    id: model.id,
    limits: model.limits ? { ...model.limits } : {},
  };
  if (model.owned_by !== undefined) internal.owned_by = model.owned_by;
  // OpenAI carries unix `created`; Anthropic carries ISO `created_at`; our
  // own /models carries both. Prefer the unix integer when both are present,
  // otherwise derive it from the ISO string. We never store created_at on
  // UpstreamModel — the public catalog rederives it from `created` so the
  // internal shape stays single-source.
  if (model.created !== undefined) {
    internal.created = model.created;
  } else if (model.created_at !== undefined) {
    const ms = Date.parse(model.created_at);
    if (!Number.isNaN(ms)) internal.created = Math.floor(ms / 1000);
  }
  const display = model.display_name ?? model.name;
  if (display !== undefined) internal.display_name = display;
  if (model.cost) internal.cost = model.cost;
  return internal;
};

// A published kind of 'embedding'/'image' (Tier 1) maps directly to its
// endpoints; a published 'chat' takes the upstream's configured endpoints
// verbatim. With no/unrecognized published kind, the id heuristic (Tier 2) runs
// and falls back to the configured endpoints when it does not match. The
// configured set may be empty, leaving the model listed but unroutable until
// the operator declares an endpoint. The result is the model's `endpoints`;
// `kind` is derived back from it.
const autoModelEndpoints = (model: CustomRawModel, configured: ModelEndpoints): ModelEndpoints => {
  if (model.kind === 'embedding') return { embeddings: {} };
  if (model.kind === 'image') return { imagesGenerations: {}, imagesEdits: {} };
  if (model.kind === 'chat') return configured;
  return inferEndpointsFromModelId(model.id) ?? configured;
};

const finalizeCustomModels = (
  response: CustomModelsResponse,
  configuredEndpoints: ModelEndpoints,
  enabledFlags: ReadonlySet<string>,
): UpstreamModel[] => {
  const models: UpstreamModel[] = [];
  for (const rawModel of response.data) {
    if (!rawModel.id) continue;
    const endpoints = autoModelEndpoints(rawModel, configuredEndpoints);
    models.push({
      ...customInternalModel(rawModel),
      kind: kindForEndpoints(endpoints),
      endpoints,
      providerData: { rawModelId: rawModel.id } satisfies CustomProviderData,
      enabledFlags,
    });
  }
  return models;
};

const pricingByRawIdFromResponse = (response: CustomModelsResponse): Map<string, ModelPricing> => {
  const pricing = new Map<string, ModelPricing>();
  for (const raw of response.data) {
    if (raw.id && raw.cost) pricing.set(raw.id, raw.cost);
  }
  return pricing;
};

export const createCustomProvider = (record: UpstreamRecord): ModelProviderInstance => {
  const { config } = assertCustomUpstreamRecord(record);
  const upstream = createCustomUpstream(record);
  const configuredEndpoints = upstream.endpoints;
  // Computed once for the auto-fetch layer: only the upstream layer applies to
  // auto models (no per-model override layer). Manual models layer their own
  // flag overrides on top, resolved per-model below.
  const upstreamFlags = resolveEffectiveFlags(defaultsForProvider('custom'), [record.flagOverrides]);

  // Manual models always emit, and their upstream ids shadow any auto copy.
  const overriddenIds = new Set(config.models.map(m => m.upstreamModelId));
  const manualModels: UpstreamModel[] = config.models.map(model => {
    // The model's flag overrides are gated by a dashboard toggle: `enabled:
    // false` skips the model layer entirely (the upstream layer wins),
    // `enabled: true` applies `values` as a final layer. See
    // `resolveEffectiveFlags` for layer semantics.
    const modelLayer = model.flagOverrides?.enabled ? model.flagOverrides.values : undefined;
    const enabledFlags = resolveEffectiveFlags(defaultsForProvider('custom'), [record.flagOverrides, modelLayer]);
    const endpoints = model.endpoints;
    const internal: UpstreamModel = {
      id: publicModelId(model),
      limits: { ...(model.limits ?? {}) },
      kind: kindForEndpoints(endpoints),
      endpoints,
      providerData: { rawModelId: model.upstreamModelId } satisfies CustomProviderData,
      enabledFlags,
    };
    if (model.display_name !== undefined) internal.display_name = model.display_name;
    if (model.cost) internal.cost = model.cost;
    return internal;
  });
  const manualPricingByUpstreamId = new Map<string, ModelPricing>(
    config.models.flatMap(m => (m.cost ? [[m.upstreamModelId, m.cost] as const] : [])),
  );

  // Last-known pricing keyed by raw model id from the auto-fetch path.
  // Populated whenever a fresh /models response flows through finalize(); read
  // synchronously by getPricingForModelKey after the manual map misses. Stays
  // empty until the first list call lands.
  let pricingByRawId: ReadonlyMap<string, ModelPricing> = new Map();
  const rememberPricing = (response: CustomModelsResponse): void => {
    pricingByRawId = pricingByRawIdFromResponse(response);
  };

  // Drop any auto-fetched model whose id is pinned by a manual override so the
  // manual copy is the only one emitted for that id.
  const autoFromResponse = (response: CustomModelsResponse): UpstreamModel[] => {
    const filtered: CustomModelsResponse = { data: response.data.filter(raw => !overriddenIds.has(raw.id)) };
    return finalizeCustomModels(filtered, configuredEndpoints, upstreamFlags);
  };

  // The emitted list is always manual-first: manual overrides precede any auto
  // models so their pinned ids win.
  const withManual = (auto: UpstreamModel[]): UpstreamModel[] => [...manualModels, ...auto];

  const call = (endpoint: EndpointKey, model: UpstreamModel, body: Record<string, unknown>, signal?: AbortSignal, headers?: Record<string, string>): Promise<ProviderCallResult> => {
    const requestBody = isStreamingEndpoint(endpoint)
      ? { ...body, stream: true, model: providerData(model).rawModelId }
      : { ...body, model: providerData(model).rawModelId };
    return upstream
      .fetch(endpoint, { method: 'POST', body: JSON.stringify(requestBody), signal }, { extraHeaders: headers })
      .then(response => ({
        response,
        modelKey: providerData(model).rawModelId,
      }));
  };

  const provider: ModelProvider = {
    getProvidedModels: () => {
      if (!config.modelsFetch.enabled) {
        // No live fetch and no store read — manual models are the whole list.
        return Promise.resolve(manualModels);
      }
      return inProcessMemo(record.id, L1_TTL_MS, async () => {
        const stored = await readModelsStore<CustomModelsBlob>(record.id);
        const now = Date.now();
        if (stored && now - stored.fetchedAt < SOFT_MS) {
          rememberPricing(stored.response);
          return withManual(autoFromResponse(stored.response));
        }
        try {
          const response = await fetchCustomModels(upstream);
          await writeModelsStore<CustomModelsBlob>(record.id, { response, fetchedAt: now });
          rememberPricing(response);
          return withManual(autoFromResponse(response));
        } catch (err) {
          if (stored && now - stored.fetchedAt < HARD_MS && isProviderModelsHttpStatus(err, 429)) {
            rememberPricing(stored.response);
            return withManual(autoFromResponse(stored.response));
          }
          throw err;
        }
      });
    },
    // Manual configuration wins over the cached upstream pricing for the same id.
    getPricingForModelKey: modelKey => manualPricingByUpstreamId.get(modelKey) ?? pricingByRawId.get(modelKey) ?? null,
    callChatCompletions: (model, body, signal, headers) => call('chat_completions', model, body, signal, headers),
    callResponses: (model, body, signal, headers) => call('responses', model, body, signal, headers),
    callMessages: (model, body, signal, headers, anthropicBeta) => call('messages', model, body, signal, mergeAnthropicBetaHeader(headers, anthropicBeta)),
    callMessagesCountTokens: (model, body, signal, headers, anthropicBeta) => call('messages_count_tokens', model, body, signal, mergeAnthropicBetaHeader(headers, anthropicBeta)),
    callEmbeddings: (model, body, signal, headers) => call('embeddings', model, body, signal, headers),
    callImagesGenerations: (model, body, signal, headers) => call('images_generations', model, body, signal, headers),
    callImagesEdits: async (model, body, signal, headers) => {
      // Custom forwards the resolved upstream model id. The runtime auto-encodes
      // the FormData with a fresh boundary and sets Content-Type itself.
      body.append('model', providerData(model).rawModelId);
      const response = await upstream.fetch('images_edits', { method: 'POST', body, signal }, { extraHeaders: headers });
      return { response, modelKey: providerData(model).rawModelId };
    },
  };

  return {
    upstream: record.id,
    providerKind: 'custom',
    name: record.name,
    disabledPublicModelIds: record.disabledPublicModelIds,
    provider,
    supportsResponsesItemReference: true,
  };
};
