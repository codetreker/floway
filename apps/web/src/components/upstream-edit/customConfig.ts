import type { ModelEndpoints, UpstreamModelConfig } from '../../api/types.ts';

export const PATH_KEYS = ['chat_completions', 'responses', 'messages', 'embeddings', 'images_generations', 'images_edits'] as const;
export type PathKey = typeof PATH_KEYS[number];

export const emptyPathOverrides = (): Record<PathKey, string> => ({
  chat_completions: '',
  responses: '',
  messages: '',
  embeddings: '',
  images_generations: '',
  images_edits: '',
});

export const seedPathOverrides = (saved: Record<string, string> | null | undefined): Record<PathKey, string> => {
  const out = emptyPathOverrides();
  if (!saved) return out;
  for (const k of PATH_KEYS) {
    const v = saved[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
};

export interface CustomDraft {
  baseUrl: string;
  authStyle: 'bearer' | 'anthropic';
  endpoints: ModelEndpoints;
  bearerToken: string;
  pathOverrides: Record<PathKey, string>;
  // Live /models browse toggle and its endpoint override; an empty endpoint
  // means "use the OpenAI default", stripped to undefined on save.
  modelsFetch: { enabled: boolean; endpoint: string };
  // Manual (overridden) model entries only — auto rows are resolved live and
  // never persisted.
  models: UpstreamModelConfig[];
}

export interface AzureDraft {
  endpoint: string;
  apiKey: string;
  models: UpstreamModelConfig[];
}

export interface CustomConfigCore {
  baseUrl: string;
  authStyle: 'bearer' | 'anthropic';
  endpoints: ModelEndpoints;
  bearerToken?: string;
  modelsFetch: { enabled: boolean; endpoint?: string };
}

// The fields shared by the persisted config and the /models browse preview.
// Keeping a single builder guarantees the browse request can never drift from
// what save() would write. An empty token or models endpoint is omitted so the
// backend keeps the secret and resolves the OpenAI default respectively.
export const buildCustomConfigCore = (draft: CustomDraft): CustomConfigCore => {
  const core: CustomConfigCore = {
    baseUrl: draft.baseUrl.trim(),
    authStyle: draft.authStyle,
    endpoints: draft.endpoints,
    modelsFetch: {
      enabled: draft.modelsFetch.enabled,
      ...(draft.modelsFetch.endpoint.trim() ? { endpoint: draft.modelsFetch.endpoint.trim() } : {}),
    },
  };
  if (draft.bearerToken.trim()) core.bearerToken = draft.bearerToken.trim();
  return core;
};

export const blankCustomDraft = (): CustomDraft => ({
  baseUrl: '',
  authStyle: 'bearer',
  endpoints: { chatCompletions: {} },
  bearerToken: '',
  pathOverrides: emptyPathOverrides(),
  modelsFetch: { enabled: true, endpoint: '' },
  models: [],
});

export const blankAzureDraft = (): AzureDraft => ({
  endpoint: '',
  apiKey: '',
  models: [{ upstreamModelId: '', kind: 'chat', endpoints: { responses: {} } }],
});
