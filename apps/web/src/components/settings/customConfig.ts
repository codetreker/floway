import type { CustomEndpoint, UpstreamModelConfig } from '../../api/types.ts';

type PathKey = 'chat_completions' | 'responses' | 'messages' | 'embeddings' | 'images_generations' | 'images_edits';

// The subset of the custom draft both the dialog (save) and CustomFields (live
// /models browse) read from. Carrying the plain shape — not a ref or model —
// lets either call site pass its own draft object.
export interface CustomConfigDraft {
  baseUrl: string;
  authStyle: 'bearer' | 'anthropic';
  supportedEndpoints: CustomEndpoint[];
  bearerToken: string;
  pathOverrides: Record<PathKey, string>;
  // Live /models browse toggle and its endpoint override; an empty endpoint
  // means "use the OpenAI default", stripped to undefined on save.
  modelsFetch: { enabled: boolean; endpoint: string };
}

// The full editor draft: the shared core plus the manual model list. The dialog
// owns the `custom` ref of this shape and feeds it into CustomFields' model, so
// declaring it once keeps that coupling compiler-enforced.
export interface CustomDraft extends CustomConfigDraft {
  // Manual (overridden) model entries only — auto rows are resolved live and
  // never persisted.
  models: UpstreamModelConfig[];
}

export interface CustomConfigCore {
  baseUrl: string;
  authStyle: 'bearer' | 'anthropic';
  supportedEndpoints: CustomEndpoint[];
  bearerToken?: string;
  modelsFetch: { enabled: boolean; endpoint?: string };
}

// The fields shared by the persisted config and the /models browse preview.
// Keeping a single builder guarantees the browse request can never drift from
// what save() would write. An empty token or models endpoint is omitted so the
// backend keeps the secret and resolves the OpenAI default respectively.
export const buildCustomConfigCore = (draft: CustomConfigDraft): CustomConfigCore => {
  const core: CustomConfigCore = {
    baseUrl: draft.baseUrl.trim(),
    authStyle: draft.authStyle,
    supportedEndpoints: draft.supportedEndpoints,
    modelsFetch: { enabled: draft.modelsFetch.enabled, ...(draft.modelsFetch.endpoint.trim() ? { endpoint: draft.modelsFetch.endpoint.trim() } : {}) },
  };
  if (draft.bearerToken.trim()) core.bearerToken = draft.bearerToken.trim();
  return core;
};
