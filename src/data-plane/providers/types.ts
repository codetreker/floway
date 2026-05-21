import type { ChatCompletionsInterceptor, GeminiInterceptor, MessagesInterceptor, ResponsesInterceptor } from '../llm/interceptors.ts';
import type { ChatCompletionsPayload } from '../shared/protocol/chat-completions.ts';
import type { EmbeddingsPayload } from '../shared/protocol/embeddings.ts';
import type { MessagesPayload } from '../shared/protocol/messages.ts';
import type { ResponsesPayload } from '../shared/protocol/responses.ts';

export type ModelEndpoint = 'chat_completions' | 'responses' | 'messages' | 'messages_count_tokens' | 'embeddings';

export interface ModelMetadata {
  id: string;
  name: string;
  version: string;
  object: string;
  owned_by?: string;
  created?: number;
  display_name?: string;
  created_at?: string;
  description?: string;
  capabilities: {
    family: string;
    type: string;
    limits: {
      max_context_window_tokens?: number;
      max_non_streaming_output_tokens?: number;
      max_prompt_tokens?: number;
      max_output_tokens?: number;
    };
    supports: {
      tool_calls?: boolean;
      parallel_tool_calls?: boolean;
      streaming?: boolean;
      vision?: boolean;
      adaptive_thinking?: boolean;
      reasoning_effort?: string[];
    };
  };
  billing?: {
    is_premium?: boolean;
    multiplier?: number;
    restricted_to?: string[];
  };
  policy?: {
    state?: string;
    terms?: string;
  };
  model_picker_enabled?: boolean;
}

export interface UpstreamModel extends ModelMetadata {
  supportedEndpoints: readonly ModelEndpoint[];
  providerData?: unknown;
}

export interface ProviderModelRecord {
  upstream: string;
  provider: ModelProvider;
  upstreamModel: UpstreamModel;
  enabledFixes: ReadonlySet<string>;
  sourceInterceptors?: ProviderSourceInterceptors;
  targetInterceptors?: ProviderTargetInterceptors;
}

export interface CatalogModel extends ModelMetadata {
  supportedEndpoints: readonly ModelEndpoint[];
  supports_generation: boolean;
}

export interface ResolvedModel extends CatalogModel {
  providers: readonly ProviderModelRecord[];
}

export interface ProviderSourceInterceptors {
  messages?: readonly MessagesInterceptor[];
  responses?: readonly ResponsesInterceptor[];
  chatCompletions?: readonly ChatCompletionsInterceptor[];
  gemini?: readonly GeminiInterceptor[];
}

export interface ProviderTargetInterceptors {
  messages?: readonly MessagesInterceptor[];
  responses?: readonly ResponsesInterceptor[];
  chatCompletions?: readonly ChatCompletionsInterceptor[];
}

export interface ModelProviderInstance {
  upstream: string;
  name: string;
  provider: ModelProvider;
  enabledFixes: ReadonlySet<string>;
  sourceInterceptors?: ProviderSourceInterceptors;
  targetInterceptors?: ProviderTargetInterceptors;
  resolveRequestedModelId?(modelId: string): string | undefined;
}

export interface ProviderCallResult {
  response: Response;
  modelKey: string;
}

export interface ModelProvider {
  getProvidedModels(): Promise<readonly UpstreamModel[]>;
  callChatCompletions(model: UpstreamModel, body: Omit<ChatCompletionsPayload, 'model'>, signal?: AbortSignal): Promise<ProviderCallResult>;
  callResponses(model: UpstreamModel, body: Omit<ResponsesPayload, 'model'>, signal?: AbortSignal): Promise<ProviderCallResult>;
  callMessages(model: UpstreamModel, body: Omit<MessagesPayload, 'model'>, signal?: AbortSignal, anthropicBeta?: readonly string[]): Promise<ProviderCallResult>;
  callMessagesCountTokens(model: UpstreamModel, body: Omit<MessagesPayload, 'model'>, signal?: AbortSignal, anthropicBeta?: readonly string[]): Promise<ProviderCallResult>;
  callEmbeddings(model: UpstreamModel, body: Omit<EmbeddingsPayload, 'model'>, signal?: AbortSignal): Promise<ProviderCallResult>;
}
