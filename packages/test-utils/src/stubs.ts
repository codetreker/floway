import type { CacheRepo, LlmTargetApi, ModelProvider, ModelProviderInstance, ProviderCandidate, ProviderModelRecord, TelemetryModelIdentity, UpstreamModel } from '@floway-dev/provider';

export const memoryCacheRepo = (): CacheRepo => {
  const store = new Map<string, string>();
  return {
    get: key => Promise.resolve(store.get(key) ?? null),
    set: (key, value) => {
      store.set(key, value);
      return Promise.resolve();
    },
    delete: key => {
      store.delete(key);
      return Promise.resolve();
    },
    deletePrefix: prefix => {
      for (const key of [...store.keys()]) if (key.startsWith(prefix)) store.delete(key);
      return Promise.resolve();
    },
  };
};

export const stubUpstreamModel = (overrides: Partial<UpstreamModel> = {}): UpstreamModel => ({
  id: 'test-model',
  limits: {},
  kind: 'chat',
  endpoints: { chatCompletions: {}, responses: {}, messages: {} },
  enabledFlags: new Set<string>(),
  ...overrides,
});

export const testTelemetryModelIdentity: TelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key',
  cost: null,
};

export const stubProvider = (overrides: Partial<ModelProvider> = {}): ModelProvider => ({
  getProvidedModels: () => Promise.resolve([]),
  getPricingForModelKey: () => null,
  callChatCompletions: () => Promise.reject(new Error('stubProvider.callChatCompletions was called')),
  callResponses: () => Promise.reject(new Error('stubProvider.callResponses was called')),
  callResponsesCompact: () => Promise.reject(new Error('stubProvider.callResponsesCompact was called')),
  callMessages: () => Promise.reject(new Error('stubProvider.callMessages was called')),
  callMessagesCountTokens: () => Promise.reject(new Error('stubProvider.callMessagesCountTokens was called')),
  callEmbeddings: () => Promise.reject(new Error('stubProvider.callEmbeddings was called')),
  callImagesGenerations: () => Promise.reject(new Error('stubProvider.callImagesGenerations was called')),
  callImagesEdits: () => Promise.reject(new Error('stubProvider.callImagesEdits was called')),
  ...overrides,
});

export const stubProviderInstance = (overrides: Partial<ModelProviderInstance> = {}): ModelProviderInstance => ({
  upstream: 'test-upstream',
  providerKind: 'custom',
  name: 'Test Upstream',
  disabledPublicModelIds: [],
  provider: stubProvider(),
  supportsResponsesItemReference: false,
  ...overrides,
});

export const stubProviderModelRecord = (overrides: Partial<ProviderModelRecord> = {}): ProviderModelRecord => {
  const provider = overrides.provider ?? stubProvider();
  return {
    upstream: 'test-upstream',
    upstreamName: 'Test Upstream',
    providerKind: 'custom',
    provider,
    upstreamModel: stubUpstreamModel(),
    enabledFlags: new Set<string>(),
    supportsResponsesItemReference: false,
    ...overrides,
  };
};

export const stubProviderCandidate = (overrides: { targetApi?: LlmTargetApi; binding?: Partial<ProviderModelRecord>; provider?: ModelProviderInstance } = {}): ProviderCandidate => {
  const provider = overrides.provider ?? stubProviderInstance();
  return {
    provider,
    binding: stubProviderModelRecord({ provider: provider.provider, ...(overrides.binding ?? {}) }),
    targetApi: overrides.targetApi ?? 'messages',
  };
};
