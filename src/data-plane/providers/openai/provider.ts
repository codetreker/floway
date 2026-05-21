import type { UpstreamConfig, EndpointKey } from '../../../repo/types.ts';
import { createOpenAiUpstream } from '../../../shared/upstream/openai.ts';
import { messagesWebSearchShimInterceptors } from '../../llm/sources/messages/interceptors/index.ts';
import { publicPathsToModelEndpoints } from '../endpoints.ts';
import { withModelInfoDefaults } from '../model-info.ts';
import type { ModelProvider, ModelProviderInstance, ProviderCallResult, UpstreamModel } from '../types.ts';
import { loadModels } from '../upstream-model-cache.ts';

interface OpenAiProviderData {
  rawModelId: string;
}

const providerData = (model: UpstreamModel): OpenAiProviderData => model.providerData as OpenAiProviderData;

export const createOpenAiProvider = (config: UpstreamConfig): ModelProviderInstance => {
  const upstream = createOpenAiUpstream(config);
  const configuredEndpoints = publicPathsToModelEndpoints(config.supportedEndpoints);
  const enabledFixes = new Set(config.enabledFixes);

  const call = (endpoint: EndpointKey, model: UpstreamModel, body: Record<string, unknown>, signal?: AbortSignal, extraHeaders?: Record<string, string>): Promise<ProviderCallResult> =>
    upstream
      .fetch(
        endpoint,
        {
          method: 'POST',
          body: JSON.stringify({
            ...body,
            model: providerData(model).rawModelId,
          }),
          signal,
        },
        extraHeaders ? { extraHeaders } : undefined,
      )
      .then(response => ({
        response,
        modelKey: providerData(model).rawModelId,
      }));

  const provider: ModelProvider = {
    async getProvidedModels() {
      const result = await loadModels(upstream);
      if (result.type === 'error') throw result.error;

      const models: UpstreamModel[] = [];
      for (const rawModel of result.data.data) {
        if (!rawModel.id) continue;
        const rawEndpoints = rawModel.supported_endpoints ? publicPathsToModelEndpoints(rawModel.supported_endpoints) : configuredEndpoints;
        const model = withModelInfoDefaults(rawModel);
        models.push({
          ...model,
          supportedEndpoints: rawEndpoints,
          providerData: {
            rawModelId: rawModel.id,
          } satisfies OpenAiProviderData,
        });
      }
      return models;
    },
    callChatCompletions: (model, body, signal) => call('chat_completions', model, body, signal),
    callResponses: (model, body, signal) => call('responses', model, body, signal),
    callMessages: (model, body, signal, anthropicBeta) => call('messages', model, body, signal, anthropicBeta && anthropicBeta.length > 0 ? { 'anthropic-beta': anthropicBeta.join(',') } : undefined),
    callMessagesCountTokens: (model, body, signal, anthropicBeta) =>
      call('messages_count_tokens', model, body, signal, anthropicBeta && anthropicBeta.length > 0 ? { 'anthropic-beta': anthropicBeta.join(',') } : undefined),
    callEmbeddings: (model, body, signal) => call('embeddings', model, body, signal),
  };

  return {
    upstream: `openai:${config.id}`,
    name: config.name,
    provider,
    enabledFixes,
    ...(enabledFixes.has('messages-web-search-shim')
      ? {
          sourceInterceptors: {
            messages: messagesWebSearchShimInterceptors,
          },
        }
      : {}),
  };
};
