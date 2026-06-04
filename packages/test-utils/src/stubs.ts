import type { CacheRepo, ImageProcessor, ImageSizeCalculator, ModelProvider, TelemetryModelIdentity, UpstreamModel } from '@floway-dev/provider';

// In-memory image processor for tests. There is no WebP codec available under
// the test runtime, so this stub returns the input bytes unchanged; it exists
// only to satisfy the ImageProcessor contract so the egress interceptors run
// end-to-end. Interceptor behaviour (which images are rewritten, what size
// calculator is used) is asserted against a dedicated spy processor in the
// interceptor tests, not against this stub.
class InMemoryImageProcessor implements ImageProcessor {
  compressToWebp(input: Uint8Array, _targetSize: ImageSizeCalculator): Promise<Uint8Array> {
    return Promise.resolve(input);
  }
}

export const createInMemoryImageProcessor = (): ImageProcessor => new InMemoryImageProcessor();

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
