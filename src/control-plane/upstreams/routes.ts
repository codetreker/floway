import type { Context } from 'hono';

import { upstreamConfigToJson } from './serialize.ts';
import { getFixCatalog, isKnownFixId } from '../../data-plane/providers/fixes.ts';
import { invalidateUpstreamModels } from '../../data-plane/providers/upstream-model-cache.ts';
import { getRepo } from '../../repo/index.ts';
import type { EndpointKey, UpstreamConfig } from '../../repo/types.ts';
import { validateUpstreamPath } from '../../shared/upstream/join.ts';
import { createOpenAiUpstream } from '../../shared/upstream/openai.ts';

const ALLOWED_ENDPOINTS = new Set(['/chat/completions', '/responses', '/v1/messages', '/embeddings']);

// Endpoints whose path the admin can override per upstream. `models` is not
// in supported_endpoints (it's an upstream-wide capability lookup, not a
// model-routing target) but its path is still admin-configurable for
// providers that mount /models outside the chat-API subpath. count_tokens is
// intentionally excluded: it follows whatever path messages resolves to.
const OVERRIDABLE_ENDPOINTS: ReadonlySet<Exclude<EndpointKey, 'messages_count_tokens'>> = new Set(['chat_completions', 'responses', 'messages', 'embeddings', 'models']);

interface UpstreamCreateBody {
  name?: unknown;
  base_url?: unknown;
  bearer_token?: unknown;
  supported_endpoints?: unknown;
  enabled?: unknown;
  sort_order?: unknown;
  enabled_fixes?: unknown;
  path_overrides?: unknown;
}

interface UpstreamUpdateBody extends UpstreamCreateBody {}

const validateString = (value: unknown, field: string): { ok: true; value: string } | { ok: false; error: string } => {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, error: `${field} is required` };
  }
  return { ok: true, value: value.trim() };
};

const validateBaseUrl = (value: unknown): { ok: true; value: string } | { ok: false; error: string } => {
  const str = validateString(value, 'base_url');
  if (!str.ok) return str;
  try {
    const u = new URL(str.value);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return { ok: false, error: 'base_url must be http(s)' };
    }
  } catch {
    return { ok: false, error: 'base_url must be a valid URL' };
  }
  return str;
};

const validateEndpoints = (value: unknown): { ok: true; value: string[] } | { ok: false; error: string } => {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false,
      error: 'supported_endpoints must be a non-empty array',
    };
  }
  const result: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string' || !ALLOWED_ENDPOINTS.has(v)) {
      return {
        ok: false,
        error: `Each supported_endpoints entry must be one of: ${[...ALLOWED_ENDPOINTS].join(', ')}`,
      };
    }
    if (!result.includes(v)) result.push(v);
  }
  return { ok: true, value: result };
};

// Validate enabled_fixes against the flag catalog. Unknown ids are
// hard-rejected so an admin typo surfaces at save time. We don't enforce
// that a flag's `appliesTo` overlaps `supported_endpoints` — assembling
// the per-target interceptor list naturally no-ops on flags that don't
// match any registered descriptor for the endpoints actually served, so
// an enabled-but-unreachable flag is harmless. Skipping the check also
// avoids drift when `supported_endpoints` is edited without revisiting
// `enabled_fixes`.
const validateEnabledFixes = (value: unknown): { ok: true; value: string[] } | { ok: false; error: string } => {
  if (!Array.isArray(value)) {
    return { ok: false, error: 'enabled_fixes must be an array of strings' };
  }
  const unknown: string[] = [];
  const known = new Set<string>();
  for (const v of value) {
    if (typeof v !== 'string') {
      return {
        ok: false,
        error: 'enabled_fixes entries must be strings',
      };
    }
    if (!isKnownFixId(v)) {
      unknown.push(v);
      continue;
    }
    known.add(v);
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `Unknown enabled_fixes ids: ${unknown.join(', ')}`,
    };
  }
  return { ok: true, value: [...known].sort() };
};

type PathOverrides = NonNullable<UpstreamConfig['pathOverrides']>;

const validatePathOverrides = (value: unknown): { ok: true; value: PathOverrides | undefined } | { ok: false; error: string } => {
  if (value === null || value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'path_overrides must be an object' };
  }
  const result: PathOverrides = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!OVERRIDABLE_ENDPOINTS.has(k as never)) {
      return {
        ok: false,
        error: `path_overrides keys must be one of: ${[...OVERRIDABLE_ENDPOINTS].join(', ')}`,
      };
    }
    const path = validateUpstreamPath(v, `path_overrides.${k}`);
    if (!path.ok) return { ok: false, error: path.error };
    result[k as keyof PathOverrides] = path.value;
  }
  return {
    ok: true,
    value: Object.keys(result).length > 0 ? result : undefined,
  };
};

const newId = (): string => `up_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

export const listUpstreams = async (c: Context) => {
  const repo = getRepo().upstreamConfigs;
  const items = await repo.list();
  return c.json(items.map(upstreamConfigToJson));
};

export const listOptionalFixes = (c: Context) => {
  return c.json(getFixCatalog());
};

export const createUpstream = async (c: Context) => {
  const body = await c.req.json<UpstreamCreateBody>();

  const name = validateString(body.name, 'name');
  if (!name.ok) return c.json({ error: name.error }, 400);

  const baseUrl = validateBaseUrl(body.base_url);
  if (!baseUrl.ok) return c.json({ error: baseUrl.error }, 400);

  const bearer = validateString(body.bearer_token, 'bearer_token');
  if (!bearer.ok) return c.json({ error: bearer.error }, 400);

  const endpoints = validateEndpoints(body.supported_endpoints);
  if (!endpoints.ok) return c.json({ error: endpoints.error }, 400);

  const fixes = validateEnabledFixes(body.enabled_fixes ?? []);
  if (!fixes.ok) return c.json({ error: fixes.error }, 400);

  const overrides = validatePathOverrides(body.path_overrides);
  if (!overrides.ok) return c.json({ error: overrides.error }, 400);

  const repo = getRepo().upstreamConfigs;
  const existing = await repo.list();
  const sortOrder = typeof body.sort_order === 'number' ? Math.floor(body.sort_order) : existing.reduce((acc, c) => Math.max(acc, c.sortOrder), -1) + 1;

  const config: UpstreamConfig = {
    id: newId(),
    name: name.value,
    baseUrl: baseUrl.value.replace(/\/+$/, ''),
    bearerToken: bearer.value,
    supportedEndpoints: endpoints.value,
    enabled: body.enabled === undefined ? true : Boolean(body.enabled),
    sortOrder,
    createdAt: new Date().toISOString(),
    enabledFixes: fixes.value,
    ...(overrides.value ? { pathOverrides: overrides.value } : {}),
  };

  await repo.save(config);
  await invalidateUpstreamModels(config.id);
  return c.json(upstreamConfigToJson(config), 201);
};

export const updateUpstream = async (c: Context) => {
  const id = c.req.param('id') ?? '';
  const repo = getRepo().upstreamConfigs;
  const existing = await repo.getById(id);
  if (!existing) return c.json({ error: 'Upstream not found' }, 404);

  const body = await c.req.json<UpstreamUpdateBody>();
  const next: UpstreamConfig = { ...existing };

  if (body.name !== undefined) {
    const name = validateString(body.name, 'name');
    if (!name.ok) return c.json({ error: name.error }, 400);
    next.name = name.value;
  }
  if (body.base_url !== undefined) {
    const baseUrl = validateBaseUrl(body.base_url);
    if (!baseUrl.ok) return c.json({ error: baseUrl.error }, 400);
    next.baseUrl = baseUrl.value.replace(/\/+$/, '');
  }
  if (body.bearer_token !== undefined) {
    const bearer = validateString(body.bearer_token, 'bearer_token');
    if (!bearer.ok) return c.json({ error: bearer.error }, 400);
    next.bearerToken = bearer.value;
  }
  if (body.supported_endpoints !== undefined) {
    const endpoints = validateEndpoints(body.supported_endpoints);
    if (!endpoints.ok) return c.json({ error: endpoints.error }, 400);
    next.supportedEndpoints = endpoints.value;
  }
  if (body.enabled !== undefined) {
    next.enabled = Boolean(body.enabled);
  }
  if (body.sort_order !== undefined && typeof body.sort_order === 'number') {
    next.sortOrder = Math.floor(body.sort_order);
  }
  if (body.enabled_fixes !== undefined) {
    const fixes = validateEnabledFixes(body.enabled_fixes);
    if (!fixes.ok) return c.json({ error: fixes.error }, 400);
    next.enabledFixes = fixes.value;
  }
  if (body.path_overrides !== undefined) {
    const overrides = validatePathOverrides(body.path_overrides);
    if (!overrides.ok) return c.json({ error: overrides.error }, 400);
    if (overrides.value) {
      next.pathOverrides = overrides.value;
    } else {
      delete next.pathOverrides;
    }
  }

  await repo.save(next);
  await invalidateUpstreamModels(next.id);
  return c.json(upstreamConfigToJson(next));
};

export const deleteUpstream = async (c: Context) => {
  const id = c.req.param('id') ?? '';
  const deleted = await getRepo().upstreamConfigs.delete(id);
  if (!deleted) return c.json({ error: 'Upstream not found' }, 404);
  await invalidateUpstreamModels(id);
  return c.json({ ok: true });
};

export const testUpstream = async (c: Context) => {
  const id = c.req.param('id') ?? '';
  const config = await getRepo().upstreamConfigs.getById(id);
  if (!config) return c.json({ error: 'Upstream not found' }, 404);

  // Drop the cached model list before probing so an admin clicking "Test"
  // immediately after editing config sees the live result, not a stale
  // 600-second snapshot.
  await invalidateUpstreamModels(id);

  const upstream = createOpenAiUpstream(config);
  try {
    const resp = await upstream.fetch('models', { method: 'GET' });
    if (!resp.ok) {
      const text = await resp.text();
      return c.json(
        {
          ok: false,
          status: resp.status,
          body: text.slice(0, 1000),
        },
        200,
      );
    }
    const data = (await resp.json()) as { data?: Array<{ id: string }> };
    const ids = Array.isArray(data?.data) ? data.data.map(m => m.id).filter((v): v is string => typeof v === 'string') : [];
    return c.json({
      ok: true,
      status: resp.status,
      model_count: ids.length,
      models: ids.slice(0, 50),
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
