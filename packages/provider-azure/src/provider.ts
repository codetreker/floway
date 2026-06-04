import { assertAzureUpstreamRecord } from './config.ts';
import { azureFetchChatCompletions, azureFetchEmbeddings, azureFetchImagesEdits, azureFetchImagesGenerations, azureFetchMessages, azureFetchMessagesCountTokens, azureFetchResponses, azureFetchResponsesCompact } from './fetch.ts';
import { parseChatCompletionsStream } from '@floway-dev/protocols/chat-completions';
import { kindForEndpoints } from '@floway-dev/protocols/common';
import { parseMessagesStream } from '@floway-dev/protocols/messages';
import { parseResponsesStream, type ResponsesResult } from '@floway-dev/protocols/responses';
import { type ModelProvider, type ModelProviderInstance, type ProviderStreamParser, type UpstreamFetchOptions, type UpstreamModel, type UpstreamModelConfig, type UpstreamRecord, defaultsForProvider, mergeAnthropicBetaHeader, publicModelId, resolveEffectiveFlags, streamingProviderCall } from '@floway-dev/provider';

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
  if (model.cost) internal.cost = model.cost;
  return internal;
};

type AzureTypedFetch = (config: ReturnType<typeof assertAzureUpstreamRecord>['config'], init: RequestInit, options?: UpstreamFetchOptions) => Promise<Response>;

export const createAzureProvider = (record: UpstreamRecord): ModelProviderInstance => {
  const azure = assertAzureUpstreamRecord(record);

  const callStreaming = <TEvent>(
    transport: AzureTypedFetch,
    model: UpstreamModel,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    headers: Record<string, string> | undefined,
    parser: ProviderStreamParser<TEvent>,
  ) => {
    const upstreamModelId = providerData(model).upstreamModelId;
    return streamingProviderCall(
      transport(
        azure.config,
        { method: 'POST', body: JSON.stringify({ ...body, stream: true, model: upstreamModelId }), signal },
        { extraHeaders: headers },
      ),
      parser,
      upstreamModelId,
      signal,
    );
  };

  const callNonStreaming = async (transport: AzureTypedFetch, model: UpstreamModel, body: Record<string, unknown>, signal?: AbortSignal, headers?: Record<string, string>) => {
    const upstreamModelId = providerData(model).upstreamModelId;
    const response = await transport(azure.config, { method: 'POST', body: JSON.stringify({ ...body, model: upstreamModelId }), signal }, { extraHeaders: headers });
    return { response, modelKey: upstreamModelId };
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
          enabledFlags: effective,
        };
      });
    },
    getPricingForModelKey(modelKey) {
      return azure.config.models.find(model => model.upstreamModelId === modelKey)?.cost ?? null;
    },
    callChatCompletions: (model, body, signal, headers) => callStreaming(azureFetchChatCompletions, model, body, signal, headers, parseChatCompletionsStream),
    callResponses: (model, body, signal, headers) => callStreaming(azureFetchResponses, model, body, signal, headers, parseResponsesStream),
    callResponsesCompact: async (model, body, signal, headers) => {
      const upstreamModelId = providerData(model).upstreamModelId;
      const response = await azureFetchResponsesCompact(
        azure.config,
        { method: 'POST', body: JSON.stringify({ ...body, model: upstreamModelId }), signal },
        { extraHeaders: headers },
      );
      return response.ok
        ? { ok: true, result: (await response.json()) as ResponsesResult, modelKey: upstreamModelId }
        : { ok: false, response, modelKey: upstreamModelId };
    },
    callMessages: (model, body, signal, headers, anthropicBeta) => callStreaming(azureFetchMessages, model, body, signal, mergeAnthropicBetaHeader(headers, anthropicBeta), parseMessagesStream),
    callMessagesCountTokens: (model, body, signal, headers, anthropicBeta) => callNonStreaming(azureFetchMessagesCountTokens, model, body, signal, mergeAnthropicBetaHeader(headers, anthropicBeta)),
    callEmbeddings: (model, body, signal, headers) => callNonStreaming(azureFetchEmbeddings, model, body, signal, headers),
    callImagesGenerations: (model, body, signal, headers) => callNonStreaming(azureFetchImagesGenerations, model, body, signal, headers),
    callImagesEdits: async (model, body, signal, headers) => {
      // Azure routes by upstream model id in the multipart `model` field; the
      // runtime re-encodes the FormData with a fresh boundary and sets
      // Content-Type itself.
      const upstreamModelId = providerData(model).upstreamModelId;
      body.append('model', upstreamModelId);
      const response = await azureFetchImagesEdits(azure.config, { method: 'POST', body, signal }, { extraHeaders: headers });
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
