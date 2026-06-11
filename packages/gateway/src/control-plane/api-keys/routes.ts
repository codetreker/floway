import type { Context } from 'hono';

import { userUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { ApiKey } from '../../repo/types.ts';
import { generateApiKeyToken } from '../../shared/api-key-tokens.ts';
import type { createKeyBody, updateKeyBody } from '../schemas.ts';

const apiKeyToJson = (key: ApiKey) => ({
  id: key.id,
  name: key.name,
  key: key.key,
  created_at: key.createdAt,
  last_used_at: key.lastUsedAt ?? null,
  upstream_ids: key.upstreamIds,
});

const validateUpstreamIdsAgainstUserCap = async (
  c: Context,
  proposed: readonly string[] | null,
): Promise<string | null> => {
  if (proposed === null) return null;
  const upstreams = await getRepo().upstreams.list();
  const known = new Set(upstreams.map(u => u.id));
  const unknown = proposed.filter(id => !known.has(id));
  if (unknown.length) return `Unknown upstream(s): ${unknown.join(', ')}`;

  const userCap = userUpstreamIdsFromContext(c);
  if (userCap === null) return null;
  const userSet = new Set(userCap);
  const blocked = proposed.filter(id => !userSet.has(id));
  return blocked.length
    ? `Some selected upstreams aren't available to your account: ${blocked.join(', ')}`
    : null;
};

const ownedKeyOr404 = async (c: Context, id: string): Promise<ApiKey | Response> => {
  const userId = c.get('userId') as number;
  const key = await getRepo().apiKeys.getById(id);
  // Returning 404 on foreign keys (rather than 403) avoids leaking the
  // existence of another user's key id to the actor.
  if (key?.userId !== userId) return c.json({ error: 'Key not found' }, 404);
  return key;
};

export const listKeys = async (c: Context) => {
  const userId = c.get('userId') as number;
  const keys = await getRepo().apiKeys.listByUserId(userId);
  return c.json(keys.map(apiKeyToJson));
};

export const createKey = async (c: CtxWithJson<typeof createKeyBody>) => {
  const userId = c.get('userId') as number;
  const body = c.req.valid('json');

  const upstreamErr = await validateUpstreamIdsAgainstUserCap(c, body.upstream_ids ?? null);
  if (upstreamErr) return c.json({ error: upstreamErr }, 400);

  const key = {
    id: crypto.randomUUID(),
    userId,
    name: body.name,
    key: generateApiKeyToken(),
    createdAt: new Date().toISOString(),
    upstreamIds: body.upstream_ids ?? null,
    deletedAt: null,
  } satisfies ApiKey;
  await getRepo().apiKeys.save(key);
  return c.json(apiKeyToJson(key), 201);
};

export const deleteKey = async (c: Context) => {
  const id = c.req.param('id')!;
  const owned = await ownedKeyOr404(c, id);
  if (owned instanceof Response) return owned;
  await getRepo().apiKeys.softDelete(id);
  return c.json({ ok: true });
};

export const rotateKey = async (c: Context) => {
  const id = c.req.param('id')!;
  const owned = await ownedKeyOr404(c, id);
  if (owned instanceof Response) return owned;

  const updated = { ...owned, key: generateApiKeyToken() } satisfies ApiKey;
  await getRepo().apiKeys.save(updated);
  return c.json(apiKeyToJson(updated));
};

export const updateKey = async (c: CtxWithJson<typeof updateKeyBody>) => {
  const id = c.req.param('id')!;
  const body = c.req.valid('json');

  if (body.name === undefined && body.upstream_ids === undefined) {
    return c.json({ error: 'Provide a new name or upstream selection to update.' }, 400);
  }

  const owned = await ownedKeyOr404(c, id);
  if (owned instanceof Response) return owned;

  if (body.upstream_ids !== undefined) {
    const err = await validateUpstreamIdsAgainstUserCap(c, body.upstream_ids);
    if (err) return c.json({ error: err }, 400);
  }

  const updated: ApiKey = {
    ...owned,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.upstream_ids !== undefined ? { upstreamIds: body.upstream_ids } : {}),
  };
  await getRepo().apiKeys.save(updated);
  return c.json(apiKeyToJson(updated));
};
