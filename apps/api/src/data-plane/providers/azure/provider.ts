import type { UpstreamRecord } from '../../../repo/types.ts';
import { assertAzureUpstreamRecord, createAzureUpstream } from '../../../shared/upstream/azure.ts';
import { publicModelId, type UpstreamModelConfig } from '../../../shared/upstream/model-config.ts';
import type { EndpointKey } from '../../../shared/upstream/types.ts';
import { mergeAnthropicBetaHeader } from '../anthropic-beta.ts';
import { isStreamingEndpoint } from '../endpoints.ts';
import { resolveEffectiveFlags } from '../flags-resolve.ts';
import { defaultsForProvider } from '../flags.ts';
import type { ModelProvider, ModelProviderInstance, ProviderCallResult, UpstreamModel } from '../types.ts';
import { kindForEndpoints } from '@floway-dev/protocols/common';

interface AzureProviderData {
  upstreamModelId: string;
}

const providerData = (model: UpstreamModel): AzureProviderData => model.providerData as AzureProviderData;

// Project an Azure model config row into the slim provider-neutral fields.
// kind/endpoints/providerData/enabledFlags are added by the caller.
const azureInternalModel = (model: UpstreamModelConfig): Omit<UpstreamModel, 'kind' | 'endpoints' | 'providerData' | 'enabledFlags'> => {
  const internal: Omit<UpstreamModel, 'kind' | 'endpoints' | 'providerData' | 'enabledFlags'> = {
    id: publicModelId(model),
    limits: { ...(model.limits ?? {}) },
  };
  if (model.display_name !== undefined) internal.display_name = model.display_name;
  return internal;
};

export const createAzureProvider = (record: UpstreamRecord): ModelProviderInstance => {
  const azure = assertAzureUpstreamRecord(record);
  const upstream = createAzureUpstream(azure);

  const call = (endpoint: EndpointKey, model: UpstreamModel, body: Record<string, unknown>, signal?: AbortSignal, headers?: Record<string, string>): Promise<ProviderCallResult> => {
    const upstreamModelId = providerData(model).upstreamModelId;
    const requestBody = isStreamingEndpoint(endpoint) ? { ...body, stream: true, model: upstreamModelId } : { ...body, model: upstreamModelId };
    return upstream
      .fetch(endpoint, { method: 'POST', body: JSON.stringify(requestBody), signal }, { extraHeaders: headers })
      .then(response => ({
        response,
        modelKey: upstreamModelId,
      }));
  };

  const provider: ModelProvider = {
    async getProvidedModels() {
      return azure.config.models.map(model => {
        // The model's flag overrides are gated by a dashboard toggle: `enabled: false`
        // skips the model layer entirely (the upstream layer wins), `enabled: true`
        // applies `values` as a final layer that can re-enable or remove flags seeded by
        // defaults or the upstream. See `resolveEffectiveFlags` for layer semantics.
        const modelLayer = model.flagOverrides?.enabled ? model.flagOverrides.values : undefined;
        const effective = resolveEffectiveFlags(defaultsForProvider('azure'), [azure.flagOverrides, modelLayer]);
        const endpoints = model.endpoints;
        return {
          ...azureInternalModel(model),
          kind: kindForEndpoints(endpoints),
          endpoints,
          providerData: {
            upstreamModelId: model.upstreamModelId,
          } satisfies AzureProviderData,
          ...(model.cost ? { cost: model.cost } : {}),
          enabledFlags: effective,
        };
      });
    },
    getPricingForModelKey(modelKey) {
      return azure.config.models.find(model => model.upstreamModelId === modelKey)?.cost ?? null;
    },
    callChatCompletions: (model, body, signal, headers) => call('chat_completions', model, body, signal, headers),
    callResponses: (model, body, signal, headers) => call('responses', model, body, signal, headers),
    callMessages: (model, body, signal, headers, anthropicBeta) => call('messages', model, body, signal, mergeAnthropicBetaHeader(headers, anthropicBeta)),
    callMessagesCountTokens: (model, body, signal, headers, anthropicBeta) => call('messages_count_tokens', model, body, signal, mergeAnthropicBetaHeader(headers, anthropicBeta)),
    callEmbeddings: (model, body, signal, headers) => call('embeddings', model, body, signal, headers),
    callImagesGenerations: (model, body, signal, headers) => call('images_generations', model, body, signal, headers),
    callImagesEdits: async (model, body, signal, headers) => {
      // Azure routes by upstream model id in the multipart `model` field; the
      // runtime re-encodes the FormData with a fresh boundary and sets
      // Content-Type itself.
      const upstreamModelId = providerData(model).upstreamModelId;
      body.append('model', upstreamModelId);
      const response = await upstream.fetch('images_edits', { method: 'POST', body, signal }, { extraHeaders: headers });
      return { response, modelKey: upstreamModelId };
    },
  };

  return {
    upstream: azure.id,
    providerKind: 'azure',
    name: azure.name,
    disabledPublicModelIds: azure.disabledPublicModelIds,
    provider,
    supportsResponsesItemReference: true,
  };
};
