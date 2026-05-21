// Flag catalog. Single source of truth for every admin-toggleable
// per-upstream behavior flag exposed by the dashboard, validated by the
// /api/upstreams endpoint, and stored in upstream_configs.enabled_fixes.
//
// The catalog only describes flags — what the toggle says to the admin
// and which endpoints it applies to. Source/target interceptor code references
// a flag by id; the
// dependency goes interceptor → flag, never the other way. This makes
// "one flag drives multiple interceptors" trivial and keeps the catalog free
// of runtime closures.
//
// Vendor-style flags (e.g. `vendor-deepseek`) are data-only — they have
// no OptionalInterceptor of their own. Other interceptors read
// `provider.enabledFixes` and dispatch on these flags to decide which
// vendor-specific protocol extension to emit. With no vendor flag set,
// behavior defaults to the OpenAI standard (no extensions).

export type FixEndpoint = 'messages' | 'responses' | 'chat_completions';

export interface Flag {
  id: string;
  label: string;
  description: string;
  // Endpoints on which an interceptor exists for this flag (or, for
  // vendor-style flags, may be read by interceptors there). Catalog
  // metadata only — admins may enable any known flag on any upstream;
  // the assembler naturally no-ops on flags whose endpoints aren't
  // actually served.
  appliesTo: readonly FixEndpoint[];
}

export const OPTIONAL_FIXES = [
  {
    id: 'vendor-deepseek',
    label: 'Vendor: DeepSeek style',
    description: 'Marks this upstream as DeepSeek-compatible. Affects some fixes below.',
    appliesTo: ['messages', 'responses', 'chat_completions'],
  },
  {
    id: 'vendor-qwen',
    label: 'Vendor: Qwen style',
    description: 'Marks this upstream as Qwen-compatible. Affects some fixes below.',
    appliesTo: ['messages', 'responses', 'chat_completions'],
  },

  {
    id: 'retry-cyber-policy',
    label: 'Retry on upstream cyber-policy block',
    description: 'Retry cyber_policy 4xx errors from the upstream (up to 10 attempts).',
    appliesTo: ['responses'],
  },
  {
    id: 'messages-web-search-shim',
    label: 'Messages web search shim',
    description: "Execute Anthropic native Messages web search through the gateway's configured search provider instead of forwarding it to the upstream.",
    appliesTo: ['messages'],
  },
  {
    id: 'deepseek-reasoning-dialect',
    label: 'DeepSeek reasoning dialect',
    description: "On Chat Completions, use DeepSeek's legacy reasoning_content field instead of OpenAI's reasoning_text.",
    appliesTo: ['chat_completions'],
  },
  {
    id: 'disable-reasoning-on-forced-tool-choice',
    label: 'Disable reasoning when caller forces a tool',
    description: "Disable reasoning in the outbound request when the caller forces a specific tool. Combine with a vendor flag above to also emit that vendor's disable signal.",
    appliesTo: ['messages', 'responses', 'chat_completions'],
  },
] as const satisfies readonly Flag[];

export type OptionalFixId = (typeof OPTIONAL_FIXES)[number]['id'];

const KNOWN_IDS = new Set<string>(OPTIONAL_FIXES.map(f => f.id));

export const getFixCatalog = (): readonly Flag[] => OPTIONAL_FIXES;

export const isKnownFixId = (id: string): id is OptionalFixId => KNOWN_IDS.has(id);
