import { fetchCustomModels, type CustomModelsResponse, type CustomRawModel } from './fetch-models.ts';
import type { UpstreamRecord } from '../../../repo/types.ts';
import { createCustomUpstream } from '../../../shared/upstream/custom.ts';
import type { EndpointKey } from '../../../shared/upstream/types.ts';
import { endpointsIncludeLlmGeneration, isStreamingEndpoint, publicPathsToModelEndpoints } from '../endpoints.ts';
import { resolveEffectiveFlags } from '../flags-resolve.ts';
import { defaultsForProvider } from '../flags.ts';
import { inProcessMemo, isProviderModelsHttpStatus, readModelsStore, writeModelsStore } from '../models-store.ts';
import type { ModelProvider, ModelProviderInstance, ProviderCallResult, UpstreamModel } from '../types.ts';

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

// Project an OpenAI-shaped raw model into the slim provider-neutral fields.
// supports_generation/upstreamEndpoints/providerData/enabledFlags are added by
// the caller.
const customInternalModel = (model: CustomRawModel): Omit<UpstreamModel, 'supports_generation' | 'upstreamEndpoints' | 'providerData' | 'enabledFlags'> => {
  const internal: Omit<UpstreamModel, 'supports_generation' | 'upstreamEndpoints' | 'providerData' | 'enabledFlags'> = {
    id: model.id,
    limits: {},
  };
  if (model.owned_by !== undefined) internal.owned_by = model.owned_by;
  if (model.created !== undefined) internal.created = model.created;
  if (model.name !== undefined) internal.display_name = model.name;
  return internal;
};

const finalizeCustomModels = (
  response: CustomModelsResponse,
  configuredEndpoints: ReturnType<typeof publicPathsToModelEndpoints>,
  enabledFlags: ReadonlySet<string>,
): UpstreamModel[] => {
  const models: UpstreamModel[] = [];
  for (const rawModel of response.data) {
    if (!rawModel.id) continue;
    const upstreamEndpoints = rawModel.supported_endpoints ? publicPathsToModelEndpoints(rawModel.supported_endpoints) : configuredEndpoints;
    models.push({
      ...customInternalModel(rawModel),
      supports_generation: endpointsIncludeLlmGeneration(upstreamEndpoints),
      upstreamEndpoints,
      providerData: { rawModelId: rawModel.id } satisfies CustomProviderData,
      enabledFlags,
    });
  }
  return models;
};

export const createCustomProvider = (record: UpstreamRecord): ModelProviderInstance => {
  const upstream = createCustomUpstream(record);
  const configuredEndpoints = publicPathsToModelEndpoints(upstream.supportedEndpoints);
  // Computed once: only the upstream layer applies for this provider kind
  // (no per-model override layer). Azure recomputes per deployment.
  const upstreamFlags = resolveEffectiveFlags(defaultsForProvider('custom'), [record.flagOverrides]);

  const call = (endpoint: EndpointKey, model: UpstreamModel, body: Record<string, unknown>, signal?: AbortSignal, extraHeaders?: Record<string, string>): Promise<ProviderCallResult> => {
    const requestBody = isStreamingEndpoint(endpoint)
      ? { ...body, stream: true, model: providerData(model).rawModelId }
      : { ...body, model: providerData(model).rawModelId };
    return upstream
      .fetch(
        endpoint,
        {
          method: 'POST',
          body: JSON.stringify(requestBody),
          signal,
        },
        extraHeaders ? { extraHeaders } : undefined,
      )
      .then(response => ({
        response,
        modelKey: providerData(model).rawModelId,
      }));
  };

  const provider: ModelProvider = {
    getProvidedModels: () =>
      inProcessMemo(record.id, L1_TTL_MS, async () => {
        const stored = await readModelsStore<CustomModelsBlob>(record.id);
        const now = Date.now();
        if (stored && now - stored.fetchedAt < SOFT_MS) {
          return finalizeCustomModels(stored.response, configuredEndpoints, upstreamFlags);
        }
        try {
          const response = await fetchCustomModels(upstream);
          await writeModelsStore<CustomModelsBlob>(record.id, { response, fetchedAt: now });
          return finalizeCustomModels(response, configuredEndpoints, upstreamFlags);
        } catch (err) {
          if (stored && now - stored.fetchedAt < HARD_MS && isProviderModelsHttpStatus(err, 429)) {
            return finalizeCustomModels(stored.response, configuredEndpoints, upstreamFlags);
          }
          throw err;
        }
      }),
    getPricingForModelKey: () => null,
    callChatCompletions: (model, body, signal) => call('chat_completions', model, body, signal),
    callResponses: (model, body, signal) => call('responses', model, body, signal),
    callMessages: (model, body, signal, anthropicBeta) => call('messages', model, body, signal, anthropicBeta && anthropicBeta.length > 0 ? { 'anthropic-beta': anthropicBeta.join(',') } : undefined),
    callMessagesCountTokens: (model, body, signal, anthropicBeta) =>
      call('messages_count_tokens', model, body, signal, anthropicBeta && anthropicBeta.length > 0 ? { 'anthropic-beta': anthropicBeta.join(',') } : undefined),
    callEmbeddings: (model, body, signal) => call('embeddings', model, body, signal),
  };

  return {
    upstream: record.id,
    providerKind: 'custom',
    name: record.name,
    provider,
  };
};
