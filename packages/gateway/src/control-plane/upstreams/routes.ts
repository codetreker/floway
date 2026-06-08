import type { Context } from 'hono';
import type { z } from 'zod';

import { upstreamRecordToJson, type SerializedUpstreamRecord } from './serialize.ts';
import { createProviderInstance } from '../../data-plane/providers/registry.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { detectAccountType, fetchGitHubUser, pollGitHubDeviceFlow, startGitHubDeviceFlow } from '../auth/github-device-flow.ts';
import type { codexImportBody, codexPkceStartBody, codexRefreshNowBody, codexReimportBody, copilotAuthPollBody, createUpstreamBody, fetchModelsBody, updateUpstreamBody } from '../schemas.ts';
import { clearModelsStore, getProviderRepo, invalidateModelsStore, ProviderModelsUnavailableError, getFlagCatalog } from '@floway-dev/provider';
import type { UpstreamProviderKind, UpstreamRecord } from '@floway-dev/provider';
import { assertAzureUpstreamRecord } from '@floway-dev/provider-azure';
import {
  type CodexAccessTokenCache,
  type CodexUpstreamConfig,
  type CodexUpstreamState,
  CODEX_AUTHORIZE_URL,
  CODEX_CLIENT_ID,
  CODEX_OAUTH_SCOPE,
  CODEX_REDIRECT_URI,
  CodexOAuthSessionTerminatedError,
  assertCodexUpstreamRecord,
  assertCodexUpstreamState,
  extractCodexCallbackParams,
  generateCodexPkce,
  getCodexQuota,
  importCodexFromAuthJson,
  importCodexFromCallback,
  putCodexAccessToken,
  refreshCodexAccessToken,
} from '@floway-dev/provider-codex';
import { clearCopilotTokenCache, isCopilotAccountType, type CopilotAccountType } from '@floway-dev/provider-copilot';
import { assertCustomUpstreamRecord, fetchCustomModels } from '@floway-dev/provider-custom';

// Serialize for the HTTP response, attaching the live KV codex_quota snapshot
// when the row is a Codex upstream. Keeps serialize.ts free of provider I/O
// and a global repo handle, while ensuring every codex-bearing response shape
// carries the quota panel data the dashboard expects.
const serializeForResponse = async (record: UpstreamRecord): Promise<SerializedUpstreamRecord> => {
  const serialized = upstreamRecordToJson(record);
  if (record.provider === 'codex') {
    serialized.codex_quota = await getCodexQuota(getProviderRepo().cache, record.id);
  }
  return serialized;
};

interface CopilotUpstreamUser {
  login: string;
  avatar_url: string;
  name: string | null;
  id: number;
}

interface CopilotUpstreamConfig {
  githubToken: string;
  accountType: CopilotAccountType;
  user: CopilotUpstreamUser;
}

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const validationError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Runtime defensive parsers for upstream records read back from D1. The
// request-time zod schemas guard incoming bodies; these parsers guard the DB
// boundary so a manually-edited or migrated row that violates the runtime
// invariants surfaces with an actionable message instead of crashing later.

const stringField = (value: unknown, field: string): string => {
  if (typeof value !== 'string') throw new Error(`Malformed copilot upstream config: ${field} must be a string`);
  return value;
};

const nonEmptyStringField = (value: unknown, field: string): string => {
  const str = stringField(value, field).trim();
  if (str === '') throw new Error(`Malformed copilot upstream config: ${field} must be a non-empty string`);
  return str;
};

const nullableStringField = (value: unknown, field: string): string | null => {
  if (value !== null && typeof value !== 'string') throw new Error(`Malformed copilot upstream config: ${field} must be a string or null`);
  return value;
};

const numberField = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`Malformed copilot upstream config: ${field} must be an integer`);
  return value;
};

const copilotUserField = (value: unknown): CopilotUpstreamUser => {
  if (!isRecord(value)) throw new Error('Malformed copilot upstream config: user must be an object');
  return {
    login: stringField(value.login, 'user.login'),
    avatar_url: stringField(value.avatar_url, 'user.avatar_url'),
    name: nullableStringField(value.name, 'user.name'),
    id: numberField(value.id, 'user.id'),
  };
};

const copilotConfigField = (value: unknown): CopilotUpstreamConfig => {
  if (!isRecord(value)) throw new Error('Malformed copilot upstream config: config must be an object');
  if (!isCopilotAccountType(value.accountType)) {
    throw new Error('Malformed copilot upstream config: accountType must be one of individual, business, enterprise');
  }
  return {
    githubToken: nonEmptyStringField(value.githubToken, 'githubToken'),
    accountType: value.accountType,
    user: copilotUserField(value.user),
  };
};

const normalizeConfig = (record: UpstreamRecord): ValidationResult<unknown> => {
  try {
    if (record.provider === 'custom') return { ok: true, value: assertCustomUpstreamRecord(record).config };
    if (record.provider === 'azure') return { ok: true, value: assertAzureUpstreamRecord(record).config };
    if (record.provider === 'codex') {
      assertCodexUpstreamRecord(record);
      return { ok: true, value: record.config };
    }
    return { ok: true, value: copilotConfigField(record.config) };
  } catch (error) {
    return { ok: false, error: validationError(error) };
  }
};

const mergeConfigPatch = (provider: UpstreamProviderKind, existing: unknown, patch: unknown): ValidationResult<unknown> => {
  if (!isRecord(patch)) return { ok: false, error: 'config must be an object' };
  const next: Record<string, unknown> = {
    ...(isRecord(existing) ? structuredClone(existing) : {}),
    ...structuredClone(patch),
  };

  if (provider === 'custom' && patch.pathOverrides === null) delete next.pathOverrides;
  return { ok: true, value: next };
};

const newId = (): string => `up_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

const nextSortOrder = (upstreams: readonly UpstreamRecord[]): number => upstreams.reduce((acc, upstream) => Math.max(acc, upstream.sortOrder), -1) + 1;

export const listUpstreams = async (c: Context) => {
  const items = await getRepo().upstreams.list();
  return c.json(await Promise.all(items.map(serializeForResponse)));
};

export const listOptionalFlags = (c: Context) => c.json(getFlagCatalog());

export const createUpstream = async (c: CtxWithJson<typeof createUpstreamBody>) => {
  const body = c.req.valid('json');

  // Codex credentials carry an OAuth refresh_token + id_token-derived identity
  // that this endpoint cannot synthesize. Route the operator to the dedicated
  // PKCE / import flow instead of letting a `provider: 'codex'` body through
  // with no credential material.
  if (body.provider === 'codex') {
    return c.json({ error: 'Use POST /api/upstreams/codex-import for codex provider' }, 400);
  }

  const existing = await getRepo().upstreams.list();
  const now = new Date().toISOString();
  const upstream: UpstreamRecord = {
    id: newId(),
    provider: body.provider,
    name: body.name,
    enabled: body.enabled ?? true,
    sortOrder: body.sort_order ?? nextSortOrder(existing),
    createdAt: now,
    updatedAt: now,
    flagOverrides: body.flag_overrides ?? {},
    disabledPublicModelIds: body.disabled_public_model_ids ?? [],
    config: body.config,
    state: null,
  };

  // Schema validated shape; this catches Azure-specific URL / endpoint-mix
  // rules and Custom-specific path-override URL parsing that live in the
  // shared/upstream/* assertion helpers.
  const config = normalizeConfig(upstream);
  if (!config.ok) return c.json({ error: config.error }, 400);

  const record = { ...upstream, config: config.value };
  await getRepo().upstreams.save(record);
  await invalidateModelsStore(record.id);
  return c.json(await serializeForResponse(record), 201);
};

export const updateUpstream = async (c: CtxWithJson<typeof updateUpstreamBody>) => {
  const id = c.req.param('id') ?? '';
  const existing = await getRepo().upstreams.getById(id);
  if (!existing) return c.json({ error: 'Upstream not found' }, 404);

  const body = c.req.valid('json');
  if (body.provider !== undefined && body.provider !== existing.provider) {
    return c.json({ error: 'provider cannot be changed' }, 400);
  }

  // Codex `config` (id_token-derived identity) and credential state are
  // owned by the dedicated re-import / refresh endpoints. Generic PATCH still
  // adjusts the surrounding row metadata (name, enabled, sort_order, flag
  // overrides, disabled model ids) but never the credential payload.
  if (existing.provider === 'codex' && body.config !== undefined) {
    return c.json({ error: 'Use POST /api/upstreams/:id/codex-reimport to update codex credentials' }, 400);
  }

  let next: UpstreamRecord = { ...existing, updatedAt: new Date().toISOString() };
  if (body.name !== undefined) next = { ...next, name: body.name };
  if (body.enabled !== undefined) next = { ...next, enabled: body.enabled };
  if (body.sort_order !== undefined) next = { ...next, sortOrder: body.sort_order };
  if (body.flag_overrides !== undefined) next = { ...next, flagOverrides: body.flag_overrides };
  if (body.disabled_public_model_ids !== undefined) next = { ...next, disabledPublicModelIds: body.disabled_public_model_ids };
  if (body.config !== undefined) {
    const config = mergeConfigPatch(existing.provider, existing.config, body.config);
    if (!config.ok) return c.json({ error: config.error }, 400);
    next = { ...next, config: config.value };
  }

  const config = normalizeConfig(next);
  if (!config.ok) return c.json({ error: config.error }, 400);
  next = { ...next, config: config.value };

  await getRepo().upstreams.save(next);
  await invalidateModelsStore(next.id);
  return c.json(await serializeForResponse(next));
};

export const deleteUpstream = async (c: Context) => {
  const id = c.req.param('id') ?? '';
  const deleted = await getRepo().upstreams.delete(id);
  if (!deleted) return c.json({ error: 'Upstream not found' }, 404);
  await invalidateModelsStore(id);
  return c.json({ ok: true });
};

// Browse the live `/models` list of a DRAFT (possibly unsaved) custom
// upstream so the editor can pick models before saving. Edit mode leaves the
// bearerToken field blank to mean "keep the stored secret"; when blank and an
// `id` is given, the stored record's secret is substituted. A brand-new draft
// must carry its own token — when none is available the assert rejects the
// empty bearerToken as a 400, and a genuine upstream call would 401 anyway.
export const fetchModels = async (c: CtxWithJson<typeof fetchModelsBody>) => {
  const { id, config } = c.req.valid('json');

  let bearerToken = config.bearerToken ?? '';
  if (bearerToken.trim() === '' && id !== undefined) {
    const existing = await getRepo().upstreams.getById(id);
    if (existing) {
      const stored = assertCustomUpstreamRecord(existing);
      bearerToken = stored.config.bearerToken;
    }
  }

  const now = new Date().toISOString();
  const record: UpstreamRecord = {
    id: id ?? newId(),
    provider: 'custom',
    name: 'Draft custom upstream',
    enabled: true,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    flagOverrides: {},
    disabledPublicModelIds: [],
    config: { ...config, bearerToken },
    state: null,
  };

  let assertedConfig;
  try {
    // assertCustomUpstreamRecord validates the record and surfaces the typed
    // config; a malformed draft or an empty bearerToken with no stored secret
    // to substitute surfaces here.
    assertedConfig = assertCustomUpstreamRecord(record).config;
  } catch (e) {
    return c.json({ error: validationError(e) }, 400);
  }

  try {
    const result = await fetchCustomModels(assertedConfig);
    return c.json(result);
  } catch (e) {
    // Mirror the control-plane /models convention: squash genuine upstream
    // HTTP/parse failures to a generic 502 without leaking provider identity.
    if (e instanceof ProviderModelsUnavailableError) {
      return c.json({ error: { message: 'Upstream model listing failed', type: 'api_error' } }, 502);
    }
    throw e;
  }
};

// List the resolved model catalog of a SAVED upstream (any provider). A
// read-only view for the dashboard — Copilot's catalog in particular is fixed
// by the upstream and the operator cannot edit it. Upstream listing failures
// surface as 502, matching the control-plane /models convention.
export const listUpstreamModels = async (c: Context) => {
  const id = c.req.param('id');
  if (!id) return c.json({ error: 'upstream id is required' }, 400);
  const record = await getRepo().upstreams.getById(id);
  if (!record) return c.json({ error: 'upstream not found' }, 404);

  try {
    const instance = await createProviderInstance(record);
    const models = await instance.provider.getProvidedModels();
    const data = models.map(model => ({
      upstreamModelId: model.id,
      publicModelId: model.id,
      kind: model.kind,
      endpoints: model.endpoints,
      ...(model.display_name !== undefined ? { display_name: model.display_name } : {}),
      ...(model.limits ? { limits: model.limits } : {}),
      ...(model.cost ? { cost: model.cost } : {}),
    }));
    return c.json({ data });
  } catch (e) {
    if (e instanceof ProviderModelsUnavailableError) {
      return c.json({ error: { message: 'Upstream model listing failed', type: 'api_error' } }, 502);
    }
    throw e;
  }
};

export const copilotAuthStart = async (c: Context) => {
  try {
    const result = await startGitHubDeviceFlow();
    if (!result.ok) return c.json({ error: result.error }, 502);
    return c.json(result.data);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 502);
  }
};

const copilotUpstreamName = (user: CopilotUpstreamUser): string => (user.login ? `GitHub Copilot (${user.login})` : 'GitHub Copilot');

const copilotConfigUserId = (config: unknown): number | null => {
  if (!isRecord(config) || !isRecord(config.user)) return null;
  return typeof config.user.id === 'number' && Number.isSafeInteger(config.user.id) ? config.user.id : null;
};

export const copilotAuthPoll = async (c: CtxWithJson<typeof copilotAuthPollBody>) => {
  try {
    const { device_code: deviceCode } = c.req.valid('json');

    const data = await pollGitHubDeviceFlow(deviceCode);

    if (data.error === 'authorization_pending') return c.json({ status: 'pending' });
    if (data.error === 'slow_down') return c.json({ status: 'slow_down', interval: data.interval });
    if (data.error) return c.json({ status: 'error', error: data.error_description ?? data.error }, 400);

    if (!data.access_token) return c.json({ status: 'error', error: 'Unknown response' }, 500);

    const user = await fetchGitHubUser(data.access_token);
    const accountType = await detectAccountType(data.access_token);
    if (!isCopilotAccountType(accountType)) {
      return c.json({ status: 'error', error: 'Unsupported Copilot account type' }, 502);
    }

    const repo = getRepo().upstreams;
    const upstreams = await repo.list();
    const existing = upstreams.find(upstream => upstream.provider === 'copilot' && copilotConfigUserId(upstream.config) === user.id);
    const now = new Date().toISOString();
    const config: CopilotUpstreamConfig = {
      githubToken: data.access_token,
      accountType,
      user,
    };

    const record: UpstreamRecord = existing
      ? {
          ...existing,
          config,
          updatedAt: now,
        }
      : {
          id: newId(),
          provider: 'copilot',
          name: copilotUpstreamName(user),
          enabled: true,
          sortOrder: nextSortOrder(upstreams),
          createdAt: now,
          updatedAt: now,
          flagOverrides: {},
          disabledPublicModelIds: [],
          config,
          state: null,
        };

    await repo.save(record);
    await clearCopilotTokenCache();
    clearModelsStore();
    await invalidateModelsStore(record.id);
    return c.json({ status: 'complete', user, upstream: await serializeForResponse(record) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 502);
  }
};

const CODEX_PKCE_PENDING_PREFIX = 'codex_oauth_pending:';
// 5 minutes mirrors auth.openai.com's authorization-code lifetime. A stale
// pending state is harmless to leave (cache evicts it) but cannot be used
// for token exchange anyway.
const CODEX_PKCE_TTL_MS = 5 * 60 * 1000;

interface CodexPkcePendingEntry {
  verifier: string;
}

const parseCodexPkcePendingEntry = (raw: string): CodexPkcePendingEntry => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Codex PKCE pending entry is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Codex PKCE pending entry is not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.verifier !== 'string' || obj.verifier === '') {
    throw new Error('Codex PKCE pending entry is missing a non-empty `verifier`');
  }
  return { verifier: obj.verifier };
};

export const codexPkceStart = async (c: CtxWithJson<typeof codexPkceStartBody>) => {
  const { verifier, challenge } = await generateCodexPkce();
  const state = crypto.randomUUID().replace(/-/g, '');
  await getRepo().cache.set(`${CODEX_PKCE_PENDING_PREFIX}${state}`, JSON.stringify({ verifier }), CODEX_PKCE_TTL_MS);

  const url = new URL(CODEX_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CODEX_CLIENT_ID);
  url.searchParams.set('redirect_uri', CODEX_REDIRECT_URI);
  url.searchParams.set('scope', CODEX_OAUTH_SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // OpenAI-side flags codex-cli sets. `id_token_add_organizations` enriches
  // the id_token with the operator's chatgpt_account_id; without it the
  // identity-parsing step in importCodex* throws. `codex_cli_simplified_flow`
  // skips the consent screen for already-authorized clients. `originator`
  // matches the data-plane originator so auth telemetry stays consistent.
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('originator', 'codex_cli_rs');

  return c.json({
    state,
    authorize_url: url.toString(),
    expires_in_seconds: Math.floor(CODEX_PKCE_TTL_MS / 1000),
  });
};

type CodexCredentialBody = z.infer<typeof codexImportBody> | z.infer<typeof codexReimportBody>;

const ingestCodexCredential = async (
  body: CodexCredentialBody,
): Promise<{ ok: true; config: CodexUpstreamConfig; state: CodexUpstreamState; accessToken: CodexAccessTokenCache } | { ok: false; error: string }> => {
  try {
    if (body.auth_json !== undefined) {
      const out = await importCodexFromAuthJson(body.auth_json);
      return { ok: true, ...out };
    }
    const cb = body.callback;
    if (!cb) return { ok: false, error: 'callback is required when auth_json is absent' };
    let code = cb.code;
    let state = cb.state;
    if (cb.callback_url !== undefined) {
      const parsed = extractCodexCallbackParams(cb.callback_url);
      code = parsed.code;
      state = parsed.state;
    }
    if (!code || !state) {
      return { ok: false, error: 'callback.code and callback.state are required (or supply callback.callback_url)' };
    }
    const cacheKey = `${CODEX_PKCE_PENDING_PREFIX}${state}`;
    const pendingRaw = await getRepo().cache.get(cacheKey);
    if (!pendingRaw) {
      return { ok: false, error: 'PKCE state not found or expired; restart the flow' };
    }
    const pending = parseCodexPkcePendingEntry(pendingRaw);
    const out = await importCodexFromCallback({ code, codeVerifier: pending.verifier });
    // Consume the cached PKCE entry so the same state cannot be replayed;
    // cache eviction handles the timeout case (it's idempotent).
    await getRepo().cache.delete(cacheKey);
    return { ok: true, ...out };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

export const codexImport = async (c: CtxWithJson<typeof codexImportBody>) => {
  const body = c.req.valid('json');
  const ingestion = await ingestCodexCredential(body);
  if (!ingestion.ok) return c.json({ error: ingestion.error }, 400);

  const existing = await getRepo().upstreams.list();
  const now = new Date().toISOString();
  // `parseCodexIdTokenClaims` already rejects tokens with a missing email,
  // so the email field is non-empty by the time we get here.
  const defaultName = `ChatGPT Codex (${ingestion.config.accounts[0].email})`;
  const upstream: UpstreamRecord = {
    id: newId(),
    provider: 'codex',
    name: body.name ?? defaultName,
    enabled: true,
    sortOrder: body.sort_order ?? nextSortOrder(existing),
    createdAt: now,
    updatedAt: now,
    flagOverrides: {},
    disabledPublicModelIds: [],
    config: ingestion.config,
    state: ingestion.state,
  };
  await getRepo().upstreams.save(upstream);
  // Seed the KV access-token slot so the first data-plane call skips the
  // immediate refresh round-trip; the cache row TTLs naturally with the
  // OAuth lifetime.
  await putCodexAccessToken(getProviderRepo().cache, upstream.id, ingestion.accessToken);
  await invalidateModelsStore(upstream.id);
  return c.json(await serializeForResponse(upstream), 201);
};

export const codexReimport = async (c: CtxWithJson<typeof codexReimportBody>) => {
  const id = c.req.param('id') ?? '';
  const existing = await getRepo().upstreams.getById(id);
  if (existing?.provider !== 'codex') {
    return c.json({ error: 'Codex upstream not found' }, 404);
  }

  const body = c.req.valid('json');
  const ingestion = await ingestCodexCredential(body);
  if (!ingestion.ok) return c.json({ error: ingestion.error }, 400);

  const next: UpstreamRecord = {
    ...existing,
    updatedAt: new Date().toISOString(),
    name: body.name ?? existing.name,
    config: ingestion.config,
    state: ingestion.state,
  };
  await getRepo().upstreams.save(next);
  await putCodexAccessToken(getProviderRepo().cache, id, ingestion.accessToken);
  await invalidateModelsStore(id);
  return c.json(await serializeForResponse(next));
};

export const codexRefreshNow = async (c: CtxWithJson<typeof codexRefreshNowBody>) => {
  const id = c.req.param('id') ?? '';
  const existing = await getRepo().upstreams.getById(id);
  if (existing?.provider !== 'codex') {
    return c.json({ error: 'Codex upstream not found' }, 404);
  }
  try {
    assertCodexUpstreamState(existing.state);
  } catch (err) {
    return c.json({ error: `Codex upstream state is malformed: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
  const state = existing.state;
  // The state schema enforces exactly one account; refresh-now mutates that
  // single entry.
  const account = state.accounts[0];
  if (account.state !== 'active') {
    return c.json({ error: `Codex upstream is ${account.state}; re-import to recover` }, 400);
  }

  try {
    const tokens = await refreshCodexAccessToken(account.refresh_token);
    const nextAccount = { ...account, refresh_token: tokens.refresh_token, state_updated_at: new Date().toISOString() };
    const nextState: CodexUpstreamState = { accounts: [nextAccount] };
    // CAS keyed on the just-read state. A losing race here means a concurrent
    // data-plane refresh already rotated the row; their write is at least as
    // fresh as ours, so we surface 409 rather than retry.
    const result = await getRepo().upstreams.saveState(id, nextState, { expectedState: state });
    if (!result.updated) {
      return c.json({ error: 'Concurrent state mutation; refresh aborted' }, 409);
    }
    await putCodexAccessToken(getProviderRepo().cache, id, {
      access_token: tokens.access_token,
      expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in,
      refreshed_at: new Date().toISOString(),
    });
    const fresh = await getRepo().upstreams.getById(id);
    return c.json(fresh ? await serializeForResponse(fresh) : { ok: true });
  } catch (err) {
    // OAuth session terminated (refresh_token replayed, revoked, or
    // app_session_terminated): mirror the data-plane behavior — flip the row
    // to `refresh_failed` so the dashboard surfaces the red badge and the
    // operator sees a Re-import affordance instead of a stale Refresh button.
    if (err instanceof CodexOAuthSessionTerminatedError) {
      const failedAccount = {
        ...account,
        state: 'refresh_failed' as const,
        state_message: err.upstreamMessage,
        state_updated_at: new Date().toISOString(),
      };
      const failedState: CodexUpstreamState = { accounts: [failedAccount] };
      // Best-effort: a losing CAS means a concurrent rotation already wrote
      // newer state, which by definition supersedes ours.
      await getRepo().upstreams.saveState(id, failedState, { expectedState: state });
      // 502, not 401 — the dashboard's auth client logs the operator out on
      // any 401 (apps/web/src/api/client.ts), and a "your codex credential
      // is dead" condition must not be confused with "your dashboard auth
      // is invalid". Same pattern as control-plane/copilot-quota/routes.ts.
      return c.json({ error: `Codex refresh failed: ${err.upstreamMessage}. Re-import the credential to recover.` }, 502);
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
};
