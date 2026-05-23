// API key management routes

import type { Context } from 'hono';

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
});

export const listKeys = async (c: Context) => {
  const isAdmin = c.get('isAdmin');
  if (isAdmin) {
    const keys = await getRepo().apiKeys.list();
    return c.json(keys.map(k => apiKeyToJson(k)));
  }
  // Non-admin: return only the caller's own key
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

export const renameKey = async (c: Context) => {
  const id = c.req.param('id') ?? '';
  const body = await c.req.json<{ name?: string }>();
  if (!body.name || typeof body.name !== 'string') {
    return c.json({ error: 'name is required' }, 400);
  }

  const repo = getRepo().apiKeys;
  const existing = await repo.getById(id);
  if (!existing) return c.json({ error: 'Key not found' }, 404);

  const updated = { ...existing, name: body.name } satisfies ApiKey;
  await repo.save(updated);
  return c.json(apiKeyToJson(updated));
};
