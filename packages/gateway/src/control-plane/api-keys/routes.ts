import { getDumpStore, notifyDisabledBestEffort } from '../../dump/registry.ts';
import { type AuthedContext, userFromContext, userUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { ApiKey } from '../../repo/types.ts';
import { generateApiKeyToken } from '../../shared/api-key-tokens.ts';
import type { createKeyBody, updateKeyBody } from '../schemas.ts';
import { ownedKeyOr404 } from '../shared/owned-key.ts';

const apiKeyToJson = (key: ApiKey) => ({
  id: key.id,
  name: key.name,
  key: key.key,
  created_at: key.createdAt,
  last_used_at: key.lastUsedAt ?? null,
  upstream_ids: key.upstreamIds,
  dump_retention_seconds: key.dumpRetentionSeconds,
});

const validateUpstreamIdsAgainstUserCap = async (
  c: AuthedContext,
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

export const listKeys = async (c: AuthedContext) => {
  const userId = userFromContext(c).id;
  const keys = await getRepo().apiKeys.listByUserId(userId);
  return c.json(keys.map(apiKeyToJson));
};

export const createKey = async (c: CtxWithJson<typeof createKeyBody>) => {
  const userId = userFromContext(c).id;
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
    dumpRetentionSeconds: null,
  } satisfies ApiKey;
  await getRepo().apiKeys.save(key);
  return c.json(apiKeyToJson(key), 201);
};

export const deleteKey = async (c: AuthedContext) => {
  const id = c.req.param('id')!;
  const owned = await ownedKeyOr404(c, id);
  if (owned instanceof Response) return owned;
  // Purge dump state before the soft-delete so a purge failure leaves a
  // retriable, still-owned key rather than a half-deleted row whose dump
  // records are orphaned beyond the operator's reach.
  await getDumpStore().purgeAll(id);
  // Cut any live SSE subscribers so the dashboard sees a clean disconnect.
  // Broker availability shouldn't block the soft-delete — clients reconcile
  // on the next keys refetch regardless.
  await notifyDisabledBestEffort(id, 'deleteKey');
  await getRepo().apiKeys.softDelete(id);
  return c.json({ ok: true });
};

export const rotateKey = async (c: AuthedContext) => {
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

  if (body.name === undefined && body.upstream_ids === undefined && body.dump_retention_seconds === undefined) {
    return c.json({ error: 'Provide a new name, upstream selection, or dump retention to update.' }, 400);
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
    ...(body.dump_retention_seconds !== undefined ? { dumpRetentionSeconds: body.dump_retention_seconds } : {}),
  };
  await getRepo().apiKeys.save(updated);

  // Retention transitions:
  //   positive → null: drop every stored record and cut every live subscriber.
  //   null → positive: no purge; the new window only governs future captures.
  //   positive → smaller positive: enforce the shorter window immediately by
  //     sweeping anything already past the new cutoff.
  //   positive → larger positive: nothing to purge; older records still fit.
  if (body.dump_retention_seconds !== undefined) {
    const previous = owned.dumpRetentionSeconds;
    const next = body.dump_retention_seconds;
    if (next === null && previous !== null) {
      await getDumpStore().purgeAll(id);
      await notifyDisabledBestEffort(id, 'updateKey retention disable');
    } else if (previous !== null && next !== null && next < previous) {
      await getDumpStore().purgeExpired(id, next);
    }
  }

  return c.json(apiKeyToJson(updated));
};
