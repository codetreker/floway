import { messagesCopilotInterceptors, messagesCopilotSourceInterceptors } from './interceptors/messages/index.ts';
import { responsesCopilotInterceptors } from './interceptors/responses/index.ts';
import { mergeClaudeVariants } from './merge-claude-variants.ts';
import { copilotPublicModelId, copilotRequestedModelAliasTarget } from './model-name.ts';
import { hasContext1mBeta, type ModelSelectionHints, resolveCopilotRawModel } from './model-selection.ts';
import type { CopilotModelsResponse, CopilotRawModel } from './types.ts';
import type { GitHubAccount, EndpointKey } from '../../../repo/types.ts';
import { createCopilotUpstream } from '../../../shared/upstream/copilot.ts';
import type { ChatCompletionsPayload } from '../../shared/protocol/chat-completions.ts';
import type { MessagesPayload } from '../../shared/protocol/messages.ts';
import type { ResponsesPayload } from '../../shared/protocol/responses.ts';
import { publicPathsToModelEndpoints } from '../endpoints.ts';
import type { OptionalFixId } from '../fixes.ts';
import { withModelInfoDefaults } from '../model-info.ts';
import type { ModelEndpoint, ModelProvider, ModelProviderInstance, ProviderCallResult, UpstreamModel } from '../types.ts';
import { loadModels } from '../upstream-model-cache.ts';

interface CopilotProviderData {
  rawModels: CopilotRawModel[];
}

const COPILOT_DEFAULT_FIXES = ['retry-cyber-policy'] as const satisfies readonly OptionalFixId[];

const ALLOWED_ANTHROPIC_BETAS = new Set(['interleaved-thinking-2025-05-14', 'context-management-2025-06-27', 'advanced-tool-use-2025-11-20']);
const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';

const providerData = (model: UpstreamModel): CopilotProviderData => model.providerData as CopilotProviderData;

const withMessagesCountTokens = (endpoints: readonly ModelEndpoint[]): ModelEndpoint[] =>
  endpoints.includes('messages') && !endpoints.includes('messages_count_tokens') ? [...endpoints, 'messages_count_tokens'] : [...endpoints];

const inferredChatCompletionsSupport = (model: CopilotRawModel): boolean => model.supported_endpoints === undefined && model.capabilities?.type === 'chat';

const inferredEmbeddingSupport = (model: CopilotRawModel): boolean => model.supported_endpoints === undefined && model.capabilities?.type === 'embeddings';

const rawModelSupportsEndpoint = (model: CopilotRawModel, endpoint: ModelEndpoint): boolean => {
  const normalized = endpoint === 'messages_count_tokens' ? 'messages' : endpoint;
  const declared = publicPathsToModelEndpoints(model.supported_endpoints ?? []);
  if (declared.includes(normalized)) return true;
  // Copilot's Anthropic-family entries have historically under-reported their
  // native Messages path. Treating claude-* as Messages-capable is a
  // Copilot-provider workaround only; custom providers must declare their own
  // supported endpoints.
  if (normalized === 'messages' && model.id.startsWith('claude-')) return true;
  if (normalized === 'chat_completions') {
    return inferredChatCompletionsSupport(model);
  }
  if (normalized === 'embeddings') return inferredEmbeddingSupport(model);
  return false;
};

const copilotModelEndpoints = (publicModel: CopilotRawModel, rawModels: readonly CopilotRawModel[]): ModelEndpoint[] => {
  if (rawModels.some(model => rawModelSupportsEndpoint(model, 'responses'))) {
    return ['responses'];
  }

  if (publicModel.id.startsWith('claude-') || rawModels.some(model => rawModelSupportsEndpoint(model, 'messages'))) {
    return withMessagesCountTokens(['messages']);
  }

  if (rawModels.some(model => rawModelSupportsEndpoint(model, 'chat_completions'))) {
    return ['chat_completions'];
  }

  return rawModels.some(model => rawModelSupportsEndpoint(model, 'embeddings')) ? ['embeddings'] : [];
};

const chatReasoningEffort = (body: Omit<ChatCompletionsPayload, 'model'>): string | undefined => (body.reasoning_effort && body.reasoning_effort !== 'none' ? body.reasoning_effort : undefined);

const messagesReasoningEffort = (body: Omit<MessagesPayload, 'model'>): string | undefined => body.output_config?.effort;

const responsesReasoningEffort = (body: Omit<ResponsesPayload, 'model'>): string | undefined => (body.reasoning?.effort && body.reasoning.effort !== 'none' ? body.reasoning.effort : undefined);

const rawModelFor = (model: UpstreamModel, endpoint: ModelEndpoint, hints: ModelSelectionHints = {}): CopilotRawModel => {
  // Copilot exposes one canonical public Claude model id per family. Raw
  // variant selection is derived from request fields such as reasoning effort
  // and anthropic-beta, not from the client's original model alias string.
  const rawModels = providerData(model).rawModels.filter(rawModel => rawModelSupportsEndpoint(rawModel, endpoint));
  if (rawModels.length === 0) {
    throw new Error(`Copilot provider exposed ${endpoint} for ${model.id}, but no raw variant supports that endpoint`);
  }
  return resolveCopilotRawModel({ object: 'list', data: rawModels }, model.id, hints) ?? rawModels[0];
};

const chatHasVision = (body: Omit<ChatCompletionsPayload, 'model'>): boolean =>
  body.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));

const messagesHasVision = (body: Omit<MessagesPayload, 'model'>): boolean => body.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image'));

const messagesInitiator = (body: Omit<MessagesPayload, 'model'>): 'user' | 'agent' => {
  const lastMessage = body.messages[body.messages.length - 1];
  if (lastMessage?.role !== 'user') return 'agent';
  if (!Array.isArray(lastMessage.content)) return 'user';

  return lastMessage.content.some(block => block.type !== 'tool_result') ? 'user' : 'agent';
};

const copilotAnthropicBetaHeader = (body: Omit<MessagesPayload, 'model'>, anthropicBeta: readonly string[] | undefined): string[] => {
  const isAdaptiveThinking = body.thinking?.type === 'adaptive';
  const filtered = (anthropicBeta ?? []).filter(value => ALLOWED_ANTHROPIC_BETAS.has(value)).filter(value => !(isAdaptiveThinking && value === INTERLEAVED_THINKING_BETA));

  if (body.thinking?.budget_tokens && !isAdaptiveThinking && !filtered.includes(INTERLEAVED_THINKING_BETA)) {
    filtered.push(INTERLEAVED_THINKING_BETA);
  }

  return [...new Set(filtered)];
};

const responsesHasVision = (body: Omit<ResponsesPayload, 'model'>): boolean => {
  if (!Array.isArray(body.input)) return false;

  return body.input.some(
    item => item.type === 'message' && Array.isArray(item.content) && item.content.some(block => (block as { type?: string }).type === 'input_image' || (block as { type?: string }).type === 'image'),
  );
};

const responsesInitiator = (body: Omit<ResponsesPayload, 'model'>): 'user' | 'agent' => {
  if (!Array.isArray(body.input)) return 'user';
  const lastItem = body.input[body.input.length - 1];
  return lastItem?.type === 'function_call_output' ? 'agent' : 'user';
};

const copilotEmbeddingsBody = (body: Record<string, unknown>): Record<string, unknown> => {
  if (typeof body.input !== 'string') return body;

  // OpenAI-compatible clients may send scalar string input, but Copilot's
  // upstream /embeddings endpoint currently returns 400 unless text input is
  // wrapped as an array. Keep this workaround at the Copilot provider boundary
  // so custom OpenAI-compatible upstreams receive the caller's body unchanged.
  // References:
  // https://platform.openai.com/docs/api-reference/embeddings/create
  // https://github.com/ericc-ch/copilot-api/blob/0ea08febdd7e3e055b03dd298bf57e669500b5c1/src/services/copilot/create-embeddings.ts#L19-L21
  // https://github.com/BerriAI/litellm/blob/c8fb77f119ad69a80f5fde088efd3a1aa77f458b/litellm/proxy/proxy_server.py#L7826-L7839
  return { ...body, input: [body.input] };
};

export const createCopilotProvider = async (account: GitHubAccount): Promise<ModelProviderInstance> => {
  const upstream = await createCopilotUpstream(account.token, account.accountType);

  const call = async (
    endpoint: EndpointKey,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    rawModel: CopilotRawModel,
    vision?: boolean,
    initiator?: 'user' | 'agent',
    anthropicBeta?: readonly string[],
  ): Promise<ProviderCallResult> => {
    const response = await upstream.fetch(
      endpoint,
      {
        method: 'POST',
        body: JSON.stringify({ ...body, model: rawModel.id }),
        signal,
      },
      {
        ...(vision ? { vision: true } : {}),
        ...(initiator ? { initiator } : {}),
        ...(anthropicBeta && anthropicBeta.length > 0
          ? {
              extraHeaders: { 'anthropic-beta': anthropicBeta.join(',') },
            }
          : {}),
      },
    );
    return { response, modelKey: rawModel.id };
  };

  const callMessagesEndpoint =
    (endpoint: 'messages' | 'messages_count_tokens') => (model: UpstreamModel, body: Omit<MessagesPayload, 'model'>, signal?: AbortSignal, anthropicBeta?: readonly string[]) => {
      const rawModel = rawModelFor(model, endpoint, {
        context1m: hasContext1mBeta(anthropicBeta),
        reasoningEffort: messagesReasoningEffort(body),
      });
      return call(endpoint, body, signal, rawModel, messagesHasVision(body), messagesInitiator(body), copilotAnthropicBetaHeader(body, anthropicBeta));
    };

  const provider: ModelProvider = {
    async getProvidedModels() {
      const result = await loadModels(upstream, {
        canReuseStaleOnModelLoadStatus: status => status === 403 || status === 429 || status === 500,
      });
      if (result.type === 'error') throw result.error;

      const rawResponse = result.data as CopilotModelsResponse;
      const rawModels = rawResponse.data.filter(model => model.id);
      const merged = mergeClaudeVariants({
        object: rawResponse.object,
        data: rawModels,
      });
      const groups = new Map<string, CopilotRawModel[]>();
      for (const rawModel of rawModels) {
        const id = copilotPublicModelId(rawModel.id);
        groups.set(id, [...(groups.get(id) ?? []), rawModel]);
      }

      const models: UpstreamModel[] = [];
      for (const mergedModel of merged.data) {
        const variants = groups.get(mergedModel.id) ?? [mergedModel];
        const endpoints = copilotModelEndpoints(mergedModel, variants);
        const model = withModelInfoDefaults(mergedModel);
        models.push({
          ...model,
          supportedEndpoints: endpoints,
          providerData: { rawModels: variants } satisfies CopilotProviderData,
        });
      }
      return models;
    },
    callChatCompletions: (model, body, signal) => {
      const rawModel = rawModelFor(model, 'chat_completions', {
        reasoningEffort: chatReasoningEffort(body),
      });
      return call('chat_completions', body, signal, rawModel, chatHasVision(body));
    },
    callResponses: (model, body, signal) => {
      const rawModel = rawModelFor(model, 'responses', {
        reasoningEffort: responsesReasoningEffort(body),
      });
      return call('responses', body, signal, rawModel, responsesHasVision(body), responsesInitiator(body));
    },
    callMessages: callMessagesEndpoint('messages'),
    callMessagesCountTokens: callMessagesEndpoint('messages_count_tokens'),
    callEmbeddings: (model, body, signal) => call('embeddings', copilotEmbeddingsBody(body), signal, rawModelFor(model, 'embeddings')),
  };

  return {
    upstream: `copilot:${account.user.id}`,
    name: account.user.login ? `GitHub Copilot (${account.user.login})` : 'GitHub Copilot',
    provider,
    enabledFixes: new Set(COPILOT_DEFAULT_FIXES),
    sourceInterceptors: {
      messages: messagesCopilotSourceInterceptors,
    },
    targetInterceptors: {
      messages: messagesCopilotInterceptors,
      responses: responsesCopilotInterceptors,
    },
    resolveRequestedModelId: copilotRequestedModelAliasTarget,
  };
};
