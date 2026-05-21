import { app } from './app.ts';
import type { ModelProvider, UpstreamModel } from './data-plane/providers/types.ts';
import { clearModelsCache } from './data-plane/providers/upstream-model-cache.ts';
import type { SearchConfig } from './data-plane/tools/web-search/types.ts';
import { initRepo } from './repo/index.ts';
import { InMemoryRepo } from './repo/memory.ts';
import type { ApiKey, GitHubAccount, TelemetryModelIdentity } from './repo/types.ts';
import { initEnv } from './runtime/env.ts';
import { clearCopilotTokenCache } from './shared/copilot.ts';
import type { Upstream } from './shared/upstream/types.ts';

interface SetupOptions {
  adminKey?: string;
  apiKey?: ApiKey;
  githubAccount?: GitHubAccount;
  searchConfig?: SearchConfig;
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

interface AppTestContext {
  repo: InMemoryRepo;
  adminKey: string;
  apiKey: ApiKey;
  githubAccount: GitHubAccount;
}

interface SSEChunk {
  event?: string;
  data: string | Record<string, unknown>;
}

let fetchLock: Promise<void> = Promise.resolve();

export async function setupAppTest(options: SetupOptions = {}): Promise<AppTestContext> {
  const repo = new InMemoryRepo();
  initRepo(repo);

  const adminKey = options.adminKey ?? 'admin-test-key';
  initEnv(name => (name === 'ADMIN_KEY' ? adminKey : ''));

  await clearCopilotTokenCache();
  clearModelsCache();

  const apiKey = options.apiKey ?? {
    id: `key_${crypto.randomUUID()}`,
    name: 'Primary key',
    key: `raw_${crypto.randomUUID().replace(/-/g, '')}`,
    createdAt: '2026-03-15T00:00:00.000Z',
  };
  await repo.apiKeys.save(apiKey);

  const githubAccount = options.githubAccount ?? {
    token: `ghu_${crypto.randomUUID().replace(/-/g, '')}`,
    accountType: 'individual',
    user: {
      id: Math.floor(Math.random() * 1000000) + 1,
      login: 'tester',
      name: 'Test User',
      avatar_url: 'https://example.com/avatar.png',
    },
  };
  await repo.github.saveAccount(githubAccount.user.id, githubAccount);

  if (options.searchConfig !== undefined) {
    await repo.searchConfig.save(options.searchConfig);
  }

  return { repo, adminKey, apiKey, githubAccount };
}

export async function withMockedFetch<T>(handler: (request: Request) => Promise<Response> | Response, run: () => Promise<T>): Promise<T> {
  let release: (() => void) | undefined;
  const previousLock = fetchLock;
  fetchLock = new Promise<void>(resolve => {
    release = resolve;
  });
  await previousLock;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: FetchInput, init?: FetchInit) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    return Promise.resolve(handler(request));
  };

  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    release?.();
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function sseResponse(chunks: SSEChunk[], status = 200): Response {
  const text = `${chunks
    .map(chunk => {
      const lines: string[] = [];
      if (chunk.event) lines.push(`event: ${chunk.event}`);
      const data = typeof chunk.data === 'string' ? chunk.data : JSON.stringify(chunk.data);
      lines.push(`data: ${data}`);
      return lines.join('\n');
    })
    .join('\n\n')}\n\n`;

  return new Response(text, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

export async function requestApp(path: string, init: RequestInit): Promise<Response> {
  return await app.request(path, init);
}

export function parseSSEText(text: string): Array<{ event: string; data: string }> {
  const blocks = text
    .split('\n\n')
    .map(block => block.trim())
    .filter(Boolean);
  return blocks.map(block => {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      if (line.startsWith('data: ')) data = line.slice(6);
    }
    return { event, data };
  });
}

export async function flushAsyncWork(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

export function copilotModels(
  models: Array<{
    id: string;
    display_name?: string;
    supported_endpoints?: string[];
    adaptiveThinking?: boolean;
    reasoningEfforts?: string[];
    maxContextWindowTokens?: number;
    maxPromptTokens?: number;
    maxOutputTokens?: number;
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
  }>,
) {
  return {
    object: 'list',
    data: models.map(model => ({
      id: model.id,
      name: model.id,
      ...(model.display_name !== undefined ? { display_name: model.display_name } : {}),
      version: '1',
      object: 'model',
      supported_endpoints: model.supported_endpoints ?? [],
      ...(model.billing ? { billing: model.billing } : {}),
      ...(model.policy ? { policy: model.policy } : {}),
      ...(model.model_picker_enabled !== undefined ? { model_picker_enabled: model.model_picker_enabled } : {}),
      capabilities: {
        family: 'test',
        type: 'chat',
        limits: {
          ...(model.maxContextWindowTokens !== undefined ? { max_context_window_tokens: model.maxContextWindowTokens } : {}),
          ...(model.maxPromptTokens !== undefined ? { max_prompt_tokens: model.maxPromptTokens } : {}),
          ...(model.maxOutputTokens !== undefined ? { max_output_tokens: model.maxOutputTokens } : {}),
        },
        supports: {
          adaptive_thinking: model.adaptiveThinking,
          ...(model.reasoningEfforts !== undefined ? { reasoning_effort: model.reasoningEfforts } : {}),
        },
      },
    })),
  };
}

// A throwaway upstream stub for unit tests that exercise the low-level upstream
// adapter cache without depending on a real network target.
export const stubUpstream = (overrides: Partial<Upstream> = {}): Upstream => ({
  id: 'test-upstream',
  name: 'Test Upstream',
  kind: 'openai',
  supportedEndpoints: ['/chat/completions', '/responses', '/v1/messages'],
  enabledFixes: new Set<string>(),
  fetch: () => Promise.reject(new Error('stubUpstream.fetch was called')),
  ...overrides,
});

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

export const testTelemetryModelIdentity: TelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key',
};

export const stubProvider = (overrides: Partial<ModelProvider> = {}): ModelProvider => ({
  getProvidedModels: () => Promise.resolve([]),
  callChatCompletions: () => Promise.reject(new Error('stubProvider.callChatCompletions was called')),
  callResponses: () => Promise.reject(new Error('stubProvider.callResponses was called')),
  callMessages: () => Promise.reject(new Error('stubProvider.callMessages was called')),
  callMessagesCountTokens: () => Promise.reject(new Error('stubProvider.callMessagesCountTokens was called')),
  callEmbeddings: () => Promise.reject(new Error('stubProvider.callEmbeddings was called')),
  ...overrides,
});
