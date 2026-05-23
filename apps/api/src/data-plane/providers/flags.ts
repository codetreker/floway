// Flag catalog. Single source of truth for every admin-toggleable
// per-upstream behavior flag exposed by the dashboard, validated by the
// /api/upstreams endpoint, and stored in upstreams.flag_overrides.
//
// The catalog only describes flags. Source/target interceptor code
// references a flag by id; the dependency goes interceptor → flag, never
// the other way. This makes "one flag drives multiple interceptors" trivial
// and keeps the catalog free of runtime closures.
//
// Vendor-style flags (e.g. `vendor-deepseek`) are data-only — they have no
// optional interceptor of their own. Other interceptors read
// `invocation.enabledFlags` and dispatch on these flags to decide which
// vendor-specific protocol extension to emit. With no vendor flag set,
// behavior defaults to the OpenAI standard.

import type { UpstreamProviderKind } from '../../repo/types.ts';

export interface Flag {
  id: string;
  label: string;
  description: string;
  // Provider kinds that turn this flag on by default. The dashboard uses this
  // to render the "Inherit" radio as "Inherit: on" or "Inherit: off". Provider
  // construction reads `defaultsForProvider(kind)` to seed the resolver.
  defaultFor: readonly UpstreamProviderKind[];
}

export const OPTIONAL_FLAGS = [
  {
    id: 'vendor-deepseek',
    label: 'Vendor: DeepSeek style',
    description: 'Marks this upstream as DeepSeek-compatible. Affects some flags below.',
    defaultFor: [],
  },
  {
    id: 'vendor-qwen',
    label: 'Vendor: Qwen style',
    description: 'Marks this upstream as Qwen-compatible. Affects some flags below.',
    defaultFor: [],
  },
  {
    id: 'retry-cyber-policy',
    label: 'Retry on upstream cyber-policy block',
    description: 'Retry cyber_policy 4xx errors from the upstream (up to 10 attempts).',
    defaultFor: ['copilot'],
  },
  {
    id: 'messages-web-search-shim',
    label: 'Messages web search shim',
    description: "Execute Anthropic native Messages web search through the gateway's configured search provider instead of forwarding it to the upstream. (When a client Messages request is routed to a non-Messages backend, the shim always runs regardless of this flag, because those targets cannot carry Anthropic server tools.)",
    defaultFor: ['copilot', 'azure'],
  },
  {
    id: 'deepseek-reasoning-dialect',
    label: 'DeepSeek reasoning dialect',
    description: "On Chat Completions, use DeepSeek's legacy reasoning_content field instead of OpenAI's reasoning_text.",
    defaultFor: [],
  },
  {
    id: 'disable-reasoning-on-forced-tool-choice',
    label: 'Disable reasoning when caller forces a tool',
    description: "Disable reasoning in the outbound request when the caller forces a specific tool. Combine with a vendor flag above to also emit that vendor's disable signal.",
    defaultFor: [],
  },
] as const satisfies readonly Flag[];

export type OptionalFlagId = (typeof OPTIONAL_FLAGS)[number]['id'];

const KNOWN_IDS = new Set<string>(OPTIONAL_FLAGS.map(f => f.id));

export const getFlagCatalog = (): readonly Flag[] => OPTIONAL_FLAGS;

export const isKnownFlagId = (id: string): id is OptionalFlagId => KNOWN_IDS.has(id);

// Provider-default flag set. Computed from the catalog's `defaultFor` field
// so the dashboard and the runtime resolver share one source of truth.
//
// Memoized: Azure's per-deployment `getProvidedModels` loop calls this once
// per deployment per request to seed the effective-flag resolver. The catalog
// is module-constant, so cache the frozen result set per provider kind.
const DEFAULTS_CACHE = new Map<UpstreamProviderKind, ReadonlySet<string>>();
export const defaultsForProvider = (kind: UpstreamProviderKind): ReadonlySet<string> => {
  let cached = DEFAULTS_CACHE.get(kind);
  if (!cached) {
    cached = new Set(OPTIONAL_FLAGS.filter(f => (f.defaultFor as readonly string[]).includes(kind)).map(f => f.id));
    DEFAULTS_CACHE.set(kind, cached);
  }
  return cached;
};

// Wire-form validator shared by every control-plane entrypoint that accepts
// flag_overrides JSON (upstream CRUD, import). Throws on any malformed
// shape, returns a sorted, validated Record<OptionalFlagId, boolean>.
// Callers that need ValidationResult semantics wrap this in try/catch.
export const parseFlagOverridesWire = (value: unknown): Record<string, boolean> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('flag_overrides must be an object of { flagId: boolean }');
  }
  const result: Record<string, boolean> = {};
  const unknown: string[] = [];
  for (const [id, on] of Object.entries(value as Record<string, unknown>)) {
    if (typeof on !== 'boolean') throw new Error(`flag_overrides.${id} must be a boolean`);
    if (!isKnownFlagId(id)) {
      unknown.push(id);
      continue;
    }
    result[id] = on;
  }
  if (unknown.length > 0) throw new Error(`Unknown flag_overrides ids: ${unknown.join(', ')}`);
  const sorted: Record<string, boolean> = {};
  for (const id of Object.keys(result).sort()) sorted[id] = result[id];
  return sorted;
};
