import type { Context } from 'hono';

import { upstreamRecordToJson } from './serialize.ts';
import { fetchCustomModels } from '../../data-plane/providers/custom/fetch-models.ts';
import { modelEndpointsToPublicPaths } from '../../data-plane/providers/endpoints.ts';
import { getFlagCatalog } from '../../data-plane/providers/flags.ts';
import { clearModelsStore, invalidateModelsStore, ProviderModelsUnavailableError } from '../../data-plane/providers/models-store.ts';
import { createProviderInstance } from '../../data-plane/providers/registry.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { UpstreamProviderKind, UpstreamRecord } from '../../repo/types.ts';
import { clearCopilotTokenCache, isCopilotAccountType, type CopilotAccountType } from '../../shared/copilot.ts';
import { assertAzureUpstreamRecord, createAzureUpstream } from '../../shared/upstream/azure.ts';
import { createCopilotUpstream } from '../../shared/upstream/copilot.ts';
import { assertCustomUpstreamRecord, createCustomUpstream } from '../../shared/upstream/custom.ts';
import type { EndpointKey, Upstream } from '../../shared/upstream/types.ts';
import { detectAccountType, fetchGitHubUser, pollGitHubDeviceFlow, startGitHubDeviceFlow } from '../auth/github-device-flow.ts';
import type { copilotAuthPollBody, createUpstreamBody, fetchModelsBody, updateUpstreamBody } from '../schemas.ts';

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

const azureProbeRequest = (upstreamModelId: string, path: string): { endpoint: EndpointKey; body: Record<string, unknown> } => {
  switch (path) {
  case '/chat/completions':
  case '/v1/chat/completions':
    return {
      endpoint: 'chat_completions',
      body: {
        model: upstreamModelId,
        messages: [{ role: 'user', content: 'Reply with ok only.' }],
        max_tokens: 16,
      },
    };
  case '/responses':
  case '/v1/responses':
    return {
      endpoint: 'responses',
      body: {
        model: upstreamModelId,
        input: 'Reply with ok only.',
        max_output_tokens: 16,
      },
    };
  case '/v1/messages':
  case '/messages':
    return {
      endpoint: 'messages',
      body: {
        model: upstreamModelId,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with ok only.' }],
      },
    };
  case '/embeddings':
  case '/v1/embeddings':
    return {
      endpoint: 'embeddings',
      body: {
        model: upstreamModelId,
        input: 'test',
      },
    };
  case '/images/generations':
  case '/v1/images/generations':
  case '/images/edits':
  case '/v1/images/edits':
    // Both image endpoints probe via /v1/images/generations: synthesizing a
    // valid multipart edits body would require a real PNG and mask, which is
    // disproportionate for a connectivity test. If the model's credentials
    // and name are valid, the generations call succeeds; edits-specific
    // failures only matter when a real client request submits real bytes.
    // The body is intentionally minimal — we omit gpt-image-2-only fields
    // like output_format that would 400 against a misconfigured dall-e model.
    return {
      endpoint: 'images_generations',
      body: {
        model: upstreamModelId,
        prompt: 'probe',
        n: 1,
        size: '1024x1024',
      },
    };
  default:
    throw new Error(`Unsupported Azure model endpoint ${path}`);
  }
};

const azureModelUsesOpenAi = (model: { supportedEndpoints: readonly string[] }): boolean =>
  model.supportedEndpoints.some(endpoint => endpoint !== '/v1/messages' && endpoint !== '/messages');

const probeModelsEndpoint = async (upstream: Upstream): Promise<{ ok: boolean; status?: number; models?: string[]; body?: string; error?: string }> => {
  try {
    const resp = await upstream.fetch('models', { method: 'GET' });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, status: resp.status, body: text.slice(0, 1000) };
    }
    const data = (await resp.json()) as { data?: Array<{ id: string }> };
    const ids = Array.isArray(data?.data) ? data.data.map(m => m.id).filter((v): v is string => typeof v === 'string') : [];
    return { ok: true, status: resp.status, models: ids.slice(0, 50) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

export const listUpstreams = async (c: Context) => {
  const items = await getRepo().upstreams.list();
  return c.json(items.map(upstreamRecordToJson));
};

export const listOptionalFlags = (c: Context) => c.json(getFlagCatalog());

export const createUpstream = async (c: CtxWithJson<typeof createUpstreamBody>) => {
  const body = c.req.valid('json');

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
    config: body.config,
  };

  // Schema validated shape; this catches Azure-specific URL / endpoint-mix
  // rules and Custom-specific path-override URL parsing that live in the
  // shared/upstream/* assertion helpers.
  const config = normalizeConfig(upstream);
  if (!config.ok) return c.json({ error: config.error }, 400);

  const record = { ...upstream, config: config.value };
  await getRepo().upstreams.save(record);
  await invalidateModelsStore(record.id);
  return c.json(upstreamRecordToJson(record), 201);
};

export const updateUpstream = async (c: CtxWithJson<typeof updateUpstreamBody>) => {
  const id = c.req.param('id') ?? '';
  const existing = await getRepo().upstreams.getById(id);
  if (!existing) return c.json({ error: 'Upstream not found' }, 404);

  const body = c.req.valid('json');
  if (body.provider !== undefined && body.provider !== existing.provider) {
    return c.json({ error: 'provider cannot be changed' }, 400);
  }

  let next: UpstreamRecord = { ...existing, updatedAt: new Date().toISOString() };
  if (body.name !== undefined) next = { ...next, name: body.name };
  if (body.enabled !== undefined) next = { ...next, enabled: body.enabled };
  if (body.sort_order !== undefined) next = { ...next, sortOrder: body.sort_order };
  if (body.flag_overrides !== undefined) next = { ...next, flagOverrides: body.flag_overrides };
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
  return c.json(upstreamRecordToJson(next));
};

export const deleteUpstream = async (c: Context) => {
  const id = c.req.param('id') ?? '';
  const deleted = await getRepo().upstreams.delete(id);
  if (!deleted) return c.json({ error: 'Upstream not found' }, 404);
  await invalidateModelsStore(id);
  return c.json({ ok: true });
};

export const testUpstream = async (c: Context) => {
  const id = c.req.param('id') ?? '';
  const config = await getRepo().upstreams.getById(id);
  if (!config) return c.json({ error: 'Upstream not found' }, 404);

  const normalized = normalizeConfig(config);
  if (!normalized.ok) return c.json({ error: normalized.error }, 400);
  const record = { ...config, config: normalized.value };
  let upstream: Upstream;
  if (record.provider === 'azure') {
    upstream = createAzureUpstream(record);
  } else if (record.provider === 'copilot') {
    const copilot = record.config as CopilotUpstreamConfig;
    upstream = createCopilotUpstream(record.id, record.name, copilot.githubToken, copilot.accountType);
  } else {
    upstream = createCustomUpstream(record);
  }

  await invalidateModelsStore(id);

  if (record.provider === 'azure') {
    const azure = assertAzureUpstreamRecord(record);
    const modelsProbe = azure.config.models.some(azureModelUsesOpenAi) ? await probeModelsEndpoint(upstream) : undefined;
    const modelProbes = [];

    for (const model of azure.config.models) {
      for (const path of model.supportedEndpoints) {
        try {
          const probe = azureProbeRequest(model.upstreamModelId, path);
          const resp = await upstream.fetch(probe.endpoint, {
            method: 'POST',
            body: JSON.stringify(probe.body),
          });
          modelProbes.push({
            upstreamModelId: model.upstreamModelId,
            endpoint: path,
            ok: resp.ok,
            status: resp.status,
            ...(resp.ok ? {} : { body: (await resp.text()).slice(0, 1000) }),
          });
        } catch (e) {
          modelProbes.push({
            upstreamModelId: model.upstreamModelId,
            endpoint: path,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    const ok = (modelsProbe?.ok ?? true) && modelProbes.every(probe => probe.ok);
    return c.json({
      ok,
      ...(modelsProbe ? { model_count: modelsProbe.models?.length ?? 0, models: modelsProbe.models ?? [], models_probe: modelsProbe } : {}),
      probes: modelProbes,
    });
  }

  try {
    const probe = await probeModelsEndpoint(upstream);
    if (!probe.ok) {
      return c.json(
        {
          ...probe,
        },
        200,
      );
    }
    return c.json({
      ok: true,
      status: probe.status,
      model_count: probe.models?.length ?? 0,
      models: probe.models ?? [],
    });
  } catch (e) {
    return c.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      },
      200,
    );
  }
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
    config: { ...config, bearerToken },
  };

  let upstream: Upstream;
  try {
    // createCustomUpstream asserts the record internally; a malformed draft or
    // an empty bearerToken with no stored secret to substitute surfaces here.
    upstream = createCustomUpstream(record);
  } catch (e) {
    return c.json({ error: validationError(e) }, 400);
  }

  try {
    const result = await fetchCustomModels(upstream);
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
      supportedEndpoints: modelEndpointsToPublicPaths(model.upstreamEndpoints),
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
          config,
        };

    await repo.save(record);
    await clearCopilotTokenCache();
    clearModelsStore();
    await invalidateModelsStore(record.id);
    return c.json({ status: 'complete', user, upstream: upstreamRecordToJson(record) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 502);
  }
};
