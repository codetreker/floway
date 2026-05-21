import type { ModelEndpoint, UpstreamModel } from './types.ts';

export interface ModelCapabilities {
  maxOutputTokens?: number;
  supportedEndpoints: readonly ModelEndpoint[];
  supportsMessages: boolean;
  supportsResponses: boolean;
  supportsChatCompletions: boolean;
  supportsMessagesCountTokens?: boolean;
  supportsEmbeddings?: boolean;
  supportsAdaptiveThinking: boolean;
}

export const getModelCapabilities = (model: UpstreamModel): ModelCapabilities => {
  const supportedEndpoints = model.supportedEndpoints;

  return {
    maxOutputTokens: model?.capabilities?.limits?.max_output_tokens,
    supportedEndpoints,
    supportsMessages: supportedEndpoints.includes('messages'),
    supportsResponses: supportedEndpoints.includes('responses'),
    supportsChatCompletions: supportedEndpoints.includes('chat_completions'),
    supportsMessagesCountTokens: supportedEndpoints.includes('messages_count_tokens'),
    supportsEmbeddings: supportedEndpoints.includes('embeddings'),
    supportsAdaptiveThinking: model?.capabilities?.supports?.adaptive_thinking === true,
  };
};
