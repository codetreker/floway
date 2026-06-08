import {
  CODEX_BACKEND_BASE,
  CODEX_CLI_VERSION,
  CODEX_MODELS_PATH,
  CODEX_ORIGINATOR,
  CODEX_USER_AGENT,
} from './constants.ts';
import { pricingForCodexModelKey } from './pricing.ts';
import type { UpstreamModel } from '@floway-dev/provider';

// Narrowed shape from /codex/models. Upstream returns
// `{ models: [{ slug, display_name, visibility, context_window, max_context_window, ... }] }`;
// we surface every entry regardless of `visibility` so the operator can
// dispatch to models the ChatGPT UI hides.
export interface CodexRawModel {
  id: string;
  display_name: string;
  // Per-request hard context window.
  context_window: number;
  // Plan-level upper bound; used when context_window is unset.
  max_context_window: number;
}

export const fetchCodexCatalog = async (opts: { accessToken: string; accountId: string; signal?: AbortSignal }): Promise<CodexRawModel[]> => {
  const response = await fetch(`${CODEX_BACKEND_BASE}${CODEX_MODELS_PATH}?client_version=${CODEX_CLI_VERSION}`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${opts.accessToken}`,
      'chatgpt-account-id': opts.accountId,
      originator: CODEX_ORIGINATOR,
      'user-agent': CODEX_USER_AGENT,
      accept: 'application/json',
    },
    signal: opts.signal,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Codex /models fetch failed: ${response.status} ${body.slice(0, 200)}`);
  }
  const parsed = await response.json() as { models?: unknown };
  if (!Array.isArray(parsed.models)) throw new Error('Codex /models response missing models array');
  return parsed.models.map(assertRawModel);
};

const assertRawModel = (value: unknown): CodexRawModel => {
  if (typeof value !== 'object' || value === null) throw new TypeError('Codex model entry is not an object');
  const obj = value as Record<string, unknown>;
  const slug = obj.slug;
  if (typeof slug !== 'string') throw new TypeError('Codex model entry missing slug');
  return {
    id: slug,
    display_name: typeof obj.display_name === 'string' ? obj.display_name : slug,
    context_window: typeof obj.context_window === 'number' ? obj.context_window : 0,
    max_context_window: typeof obj.max_context_window === 'number' ? obj.max_context_window : 0,
  };
};

// Codex exposes only the Responses endpoint. Pricing is looked up from the
// per-slug table in pricing.ts so the dashboard can report a notional
// API-rate cost even though Codex itself bills as a flat-fee subscription.
export const codexRawToUpstreamModel = (raw: CodexRawModel): UpstreamModel => {
  const cost = pricingForCodexModelKey(raw.id);
  return {
    id: raw.id,
    display_name: raw.display_name,
    owned_by: 'openai',
    kind: 'chat',
    limits: {
      max_context_window_tokens: raw.context_window || raw.max_context_window || undefined,
    },
    endpoints: { responses: {} },
    enabledFlags: new Set<string>(),
    ...(cost ? { cost } : {}),
  };
};
