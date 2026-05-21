import type { TelemetryModelIdentity } from '../../../../../repo/types.ts';
import type { ModelProvider, UpstreamModel } from '../../../../providers/types.ts';
import type { ChatCompletionsPayload } from '../../../../shared/protocol/chat-completions.ts';
import type { ChatCompletionsInvocation, RequestContext } from '../../../interceptors.ts';

export const stubUpstreamModel = (overrides: Partial<UpstreamModel> = {}): UpstreamModel => ({
  id: 'test-model',
  name: 'test-model',
  version: 'test-model',
  object: 'model',
  capabilities: {
    family: 'test-model',
    type: 'chat',
    limits: {},
    supports: {},
  },
  supportedEndpoints: ['chat_completions', 'responses', 'messages'],
  ...overrides,
});

export const stubProvider = (overrides: Partial<ModelProvider> = {}): ModelProvider => ({
  getProvidedModels: () => Promise.resolve([]),
  callChatCompletions: () => Promise.reject(new Error('stubProvider.callChatCompletions was called')),
  callResponses: () => Promise.reject(new Error('stubProvider.callResponses was called')),
  callMessages: () => Promise.reject(new Error('stubProvider.callMessages was called')),
  callMessagesCountTokens: () => Promise.reject(new Error('stubProvider.callMessagesCountTokens was called')),
  callEmbeddings: () => Promise.reject(new Error('stubProvider.callEmbeddings was called')),
  ...overrides,
});

export const testTelemetryModelIdentity: TelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key',
};

export const chatCompletionsInvocation = (payload: ChatCompletionsPayload, enabledFixes: ReadonlySet<string> = new Set()): ChatCompletionsInvocation => ({
  sourceApi: 'chat-completions',
  targetApi: 'chat-completions',
  model: payload.model,
  upstream: 'test-upstream',
  upstreamModel: stubUpstreamModel(),
  provider: stubProvider(),
  enabledFixes,
  payload,
});

export const stubRequestContext: RequestContext = {
  requestStartedAt: 0,
  runtimeLocation: 'test',
  clientStream: false,
  recordUsage: async () => {},
  recordRequestPerformance: () => {},
};
