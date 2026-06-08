// Centralized zod schemas for every control-plane route that carries a JSON
// body or non-trivial query string. Two purposes:
//
// 1. Runtime guard — zValidator rejects malformed input before it reaches a
//    handler, with a 400 + `{ error: msg }` response matching the pre-existing
//    hand-written validation shape.
//
// 2. Type inference for the Hono RPC client — `hc<AppType>(...)` reads the
//    schemas attached to each route to type `$post({ json })`, `$patch({ json })`,
//    `$get({ query })`, etc. The frontend therefore gets autocomplete on the
//    request shape without a separate codegen step.
//
// Deep upstream-config validation (e.g. Azure URL hostname rules, custom
// pathOverrides and modelsFetch.endpoint URL parsing, per-model endpoint path
// checks) intentionally stays in the handler functions — they own the
// canonical error messages and downstream cache invalidation. The schemas
// here describe the shape the dashboard sends.

import { z } from 'zod';

import { normalizeDisabledPublicModelIds } from '../repo/disabled-public-models.ts';
import { OPTIONAL_FLAGS, parseFlagOverridesWire } from '@floway-dev/provider';

// --- shared atoms ---

const knownFlagIds = new Set<string>(OPTIONAL_FLAGS.map(f => f.id));

// Reuse the runtime parseFlagOverridesWire so unknown-id and type errors
// produce the same messages the dashboard already surfaces. z.unknown() →
// transform keeps the schema-validated output typed as Record<string, boolean>
// for the RPC client.
const flagOverridesSchema = z.unknown().transform((value, ctx): Record<string, boolean> => {
  try {
    return parseFlagOverridesWire(value);
  } catch (e) {
    ctx.issues.push({ code: 'custom', message: e instanceof Error ? e.message : String(e), input: value });
    return z.NEVER as never;
  }
});

const flagOverrideValuesSchema = z.record(z.string(), z.boolean()).refine(
  overrides => Object.keys(overrides).every(id => knownFlagIds.has(id)),
  'Unknown flag id in model flag overrides',
);

// Like flag_overrides, the disabled-models field normalizes at the API edge so a
// create/update response echoes exactly what gets persisted (trimmed, de-duped).
// There is no id allowlist to enforce — any string is a legal public model id —
// so this only trims and de-dupes rather than rejecting unknown ids.
const disabledPublicModelIdsSchema = z.array(z.string()).transform(normalizeDisabledPublicModelIds);

// The structured endpoint capability map, shared by per-model config and the
// custom upstream-level fallback. A present key declares the endpoint is served.
// One concept, all endpoints — the runtime validators enforce presence/emptiness
// rules.
const modelEndpointsSchema = z.object({
  chatCompletions: z.object({}).optional(),
  responses: z.object({}).optional(),
  messages: z.object({}).optional(),
  embeddings: z.object({}).optional(),
  imagesGenerations: z.object({}).optional(),
  imagesEdits: z.object({}).optional(),
});

// Mirrors the runtime UpstreamModelConfig in @floway-dev/provider.
// Azure and custom upstreams share this per-model entry; the canonical
// per-model endpoint validation lives in the runtime validator.
const upstreamModelSchema = z.object({
  upstreamModelId: z.string().min(1),
  publicModelId: z.string().optional(),
  kind: z.enum(['chat', 'embedding', 'image']).optional(),
  endpoints: modelEndpointsSchema,
  display_name: z.string().optional(),
  cost: z.object({
    input: z.number().optional(),
    output: z.number().optional(),
    input_cache_read: z.number().optional(),
    input_cache_write: z.number().optional(),
    input_image: z.number().optional(),
    output_image: z.number().optional(),
  }).optional(),
  flagOverrides: z.object({
    enabled: z.boolean(),
    values: flagOverrideValuesSchema,
  }).optional(),
  limits: z.object({
    max_context_window_tokens: z.number().optional(),
    max_prompt_tokens: z.number().optional(),
    max_output_tokens: z.number().optional(),
  }).optional(),
});

const customConfigSchema = z.object({
  baseUrl: z.string().min(1),
  // Records written before authStyle existed default to bearer; the runtime
  // parser in shared/upstream/custom.ts uses the same default, so accept
  // omitted authStyle here for parity with import/legacy payloads.
  authStyle: z.enum(['bearer', 'anthropic']).optional(),
  // Structured capability map (one concept, all endpoints) — the runtime parser
  // permits an empty map for an upstream serving only kind-derived models.
  endpoints: modelEndpointsSchema,
  bearerToken: z.string().optional(),
  // PATCH passes `null` to explicitly clear pathOverrides; nullable() keeps
  // that escape hatch. The `/models` path no longer lives here — it is part of
  // the modelsFetch toggle below.
  pathOverrides: z.record(z.string(), z.string()).nullable().optional(),
  // Live upstream /models fetch. `endpoint` parsing happens in the runtime.
  modelsFetch: z.object({ enabled: z.boolean(), endpoint: z.string().optional() }).optional(),
  // Statically configured per-model overrides merged with the live fetch.
  models: z.array(upstreamModelSchema).optional(),
});

const azureConfigSchema = z.object({
  endpoint: z.string().min(1),
  apiKey: z.string().optional(),
  models: z.array(upstreamModelSchema).min(1, 'models must be a non-empty array'),
});

const copilotConfigSchema = z.object({
  githubToken: z.string().min(1),
  accountType: z.enum(['individual', 'business', 'enterprise']),
  user: z.object({
    login: z.string(),
    avatar_url: z.string(),
    name: z.string().nullable(),
    id: z.number(),
  }),
});

// --- auth ---

export const authLoginBody = z.object({
  key: z.string().min(1),
});

// --- api keys ---

export const createKeyBody = z.object({
  name: z.string().min(1),
});

// upstream_ids: null = inherit global order, non-empty unique string[] = whitelist.
// Empty array is rejected because a key that allows zero upstreams cannot serve
// any model and the UI has no affordance to express that intent.
const upstreamIdsValueSchema = z.array(z.string().min(1))
  .min(1, 'upstream_ids must contain at least one upstream id; use null for Default mode')
  .refine(arr => new Set(arr).size === arr.length, { message: 'upstream_ids contains duplicates' })
  .nullable();

export const updateKeyBody = z.object({
  name: z.string().min(1).optional(),
  upstream_ids: upstreamIdsValueSchema.optional(),
});

// --- upstreams ---

const upstreamBaseFields = {
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  sort_order: z.number().int().optional(),
  flag_overrides: flagOverridesSchema.optional(),
  disabled_public_model_ids: disabledPublicModelIdsSchema.optional(),
};

// Create accepts a discriminated union on `provider` so frontends get
// shape-specific autocomplete on `config`. Copilot upstreams normally
// originate from the device-flow poll endpoint, but POST also accepts them
// for the import flow. `enabled` and `sort_order` are optional — the handler
// defaults them to `true` and `nextSortOrder()` respectively when omitted.
//
// `codex` is listed here so the handler can return the canonical
// "use POST /api/upstreams/codex-import" 400 instead of the cryptic zod
// "invalid discriminator value" message. The `config` slot is `unknown()`
// because the real Codex config is derived from the OAuth/`auth.json` flow,
// not from anything the dashboard would post against this endpoint.
export const createUpstreamBody = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('custom'), ...upstreamBaseFields, config: customConfigSchema }),
  z.object({ provider: z.literal('azure'), ...upstreamBaseFields, config: azureConfigSchema }),
  z.object({ provider: z.literal('copilot'), ...upstreamBaseFields, config: copilotConfigSchema }),
  z.object({ provider: z.literal('codex'), ...upstreamBaseFields, config: z.unknown() }),
]);

// Update is provider-agnostic: provider is read from the existing record, and
// the config shape is validated by the handler against that record's provider.
// Patches omit fields they don't change; `config` may be a partial patch object
// that the handler shallow-merges with the existing config.
//
// `provider` may appear in the body so the handler can return the canonical
// "provider cannot be changed" 400 when a caller tries to switch providers;
// without this field the schema would silently strip it and the API would
// look like it had accepted the change.
export const updateUpstreamBody = z.object({
  provider: z.enum(['custom', 'azure', 'copilot', 'codex']).optional(),
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  sort_order: z.number().int().optional(),
  flag_overrides: flagOverridesSchema.optional(),
  disabled_public_model_ids: disabledPublicModelIdsSchema.optional(),
  config: z.unknown().optional(),
});

// Draft /models browse: the editor sends an in-progress (possibly unsaved)
// custom config to fetch the upstream's live model list before saving. `id`
// is present in edit mode so the handler can substitute the stored secret
// when the bearerToken field is left blank ("keep the stored secret").
export const fetchModelsBody = z.object({
  id: z.string().optional(),
  config: customConfigSchema,
});

// --- copilot device flow ---

export const copilotAuthPollBody = z.object({
  device_code: z.string().min(1),
});

// --- codex import / PKCE / refresh ---
//
// The control plane refuses `provider: 'codex'` on the generic create / update
// upstream endpoints; Codex credentials enter only through these dedicated
// routes so the PKCE verifier handoff and id_token parsing live in one place.

export const codexPkceStartBody = z.object({});

// Path A — operator pastes `~/.codex/auth.json` verbatim. Path B — operator
// supplies the OAuth callback, identified by the prior PKCE-start `state`. The
// two paths are mutually exclusive; the refine below catches the both-or-
// neither case before the handler runs.
const codexCredentialFields = {
  auth_json: z.unknown().optional(),
  callback: z.object({
    code: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    // Either `{code, state}` or `callback_url` (which we parse) — the handler
    // picks `callback_url` first when present.
    callback_url: z.string().min(1).optional(),
  }).optional(),
};

const requireExactlyOneCredential = (b: { auth_json?: unknown; callback?: unknown }): boolean =>
  (b.auth_json !== undefined) !== (b.callback !== undefined);

const codexCredentialRefineMessage = { message: 'Provide exactly one of auth_json or callback' };

// Both `codexImportBody.name` and `codexReimportBody.name` are optional. On
// import, the server synthesizes a default name from the id_token-derived
// identity (matching how copilot's device flow auto-names rows from the
// GitHub login); the operator can rename later from the edit page. On
// re-import, the existing row already has a name, so omitting it is the
// common case.
export const codexImportBody = z.object({
  name: z.string().min(1).optional(),
  sort_order: z.number().int().optional(),
  ...codexCredentialFields,
}).refine(requireExactlyOneCredential, codexCredentialRefineMessage);

// `sort_order` is omitted because re-import must not re-rank the row.
export const codexReimportBody = z.object({
  name: z.string().min(1).optional(),
  ...codexCredentialFields,
}).refine(requireExactlyOneCredential, codexCredentialRefineMessage);

export const codexRefreshNowBody = z.object({});

// --- search config ---

export const searchConfigSchema = z.object({
  provider: z.enum(['disabled', 'tavily', 'microsoft-grounding']),
  tavily: z.object({ apiKey: z.string() }),
  microsoftGrounding: z.object({ apiKey: z.string() }),
});

// --- data transfer ---

export const importBody = z.object({
  version: z.literal(3, { error: 'version must be 3' }),
  mode: z.enum(['merge', 'replace'], { error: "mode must be 'merge' or 'replace'" }),
  data: z.unknown().optional(),
});

export const exportQuery = z.object({
  include_performance: z.string().optional(),
});

// --- query strings (token-usage, search-usage, performance) ---
//
// start/end stay optional in the schema (rather than `.min(1)`) so the
// handler can return the canonical "start and end query parameters are
// required" message its tests assert on. The schema's job here is to
// inform the RPC client of the available fields, not duplicate the
// required-ness check.

const usageBaseQuery = {
  start: z.string().optional(),
  end: z.string().optional(),
  key_id: z.string().optional(),
  include_key_metadata: z.string().optional(),
};

export const tokenUsageQuery = z.object(usageBaseQuery);
export const searchUsageQuery = z.object({
  ...usageBaseQuery,
  provider: z.string().optional(),
});

export const performanceQuery = z.object({
  ...usageBaseQuery,
  metric_scope: z.enum(['request_total', 'upstream_success']).optional(),
  group_by: z.enum(['none', 'keyId', 'model', 'sourceApi', 'targetApi', 'runtimeLocation']).optional(),
  bucket: z.enum(['hour', '4h', '8h', 'day', 'all']).optional(),
  timezone_offset_minutes: z.string().optional(),
});
