import type { Context } from 'hono';

import { parseUpstreamIdsValue } from './upstream-ids.ts';
import { getRepo } from '../../repo/index.ts';
import type { ApiKey } from '../../repo/types.ts';

const generateKey = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
};

const apiKeyToJson = (key: ApiKey) => ({
  id: key.id,
  name: key.name,
  key: key.key,
  created_at: key.createdAt,
  last_used_at: key.lastUsedAt ?? null,
  upstream_ids: key.upstreamIds,
});

export const listKeys = async (c: Context) => {
  const isAdmin = c.get('isAdmin');
  if (isAdmin) {
    const keys = await getRepo().apiKeys.list();
    return c.json(keys.map(k => apiKeyToJson(k)));
  }
  const keyId = c.get('apiKeyId') as string;
  const key = await getRepo().apiKeys.getById(keyId);
  return c.json(key ? [apiKeyToJson(key)] : []);
};

export const createKey = async (c: Context) => {
  const body = await c.req.json<{ name?: string }>();
  if (!body.name || typeof body.name !== 'string') {
    return c.json({ error: 'name is required' }, 400);
  }

  const key = {
    id: crypto.randomUUID(),
    name: body.name,
    key: generateKey(),
    createdAt: new Date().toISOString(),
    upstreamIds: null,
  } satisfies ApiKey;
  await getRepo().apiKeys.save(key);
  return c.json(apiKeyToJson(key), 201);
};

export const deleteKey = async (c: Context) => {
  const id = c.req.param('id') ?? '';
  const deleted = await getRepo().apiKeys.delete(id);
  if (!deleted) return c.json({ error: 'Key not found' }, 404);
  return c.json({ ok: true });
};

export const rotateKey = async (c: Context) => {
  const id = c.req.param('id') ?? '';
  const repo = getRepo().apiKeys;
  const existing = await repo.getById(id);
  if (!existing) return c.json({ error: 'Key not found' }, 404);

  const updated = { ...existing, key: generateKey() } satisfies ApiKey;
  await repo.save(updated);
  return c.json(apiKeyToJson(updated));
};

export const updateKey = async (c: Context) => {
  const id = c.req.param('id') ?? '';
  const body = await c.req.json<{ name?: unknown; upstream_ids?: unknown }>();

  const namePatch = body.name === undefined ? undefined : (typeof body.name === 'string' && body.name.length > 0 ? body.name : null);
  if (namePatch === null) return c.json({ error: 'name must be a non-empty string' }, 400);

  let upstreamIdsPatch: string[] | null | undefined;
  if ('upstream_ids' in body && body.upstream_ids !== undefined) {
    const parsed = parseUpstreamIdsValue(body.upstream_ids);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    upstreamIdsPatch = parsed.value;
  }

  if (namePatch === undefined && upstreamIdsPatch === undefined) {
    return c.json({ error: 'at least one of name or upstream_ids must be provided' }, 400);
  }

  if (upstreamIdsPatch !== undefined && upstreamIdsPatch !== null) {
    const upstreams = await getRepo().upstreams.list();
    const knownIds = new Set(upstreams.map(u => u.id));
    const unknown = upstreamIdsPatch.filter(uid => !knownIds.has(uid));
    if (unknown.length > 0) return c.json({ error: `unknown upstream id(s): ${unknown.join(', ')}` }, 400);
  }

  const repo = getRepo().apiKeys;
  const existing = await repo.getById(id);
  if (!existing) return c.json({ error: 'Key not found' }, 404);

  const updated: ApiKey = {
    ...existing,
    ...(namePatch !== undefined ? { name: namePatch } : {}),
    ...(upstreamIdsPatch !== undefined ? { upstreamIds: upstreamIdsPatch } : {}),
  };
  await repo.save(updated);
  return c.json(apiKeyToJson(updated));
};
