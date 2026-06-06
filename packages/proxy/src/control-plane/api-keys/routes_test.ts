import { test } from 'vitest';

import { buildCustomUpstreamRecord, requestApp, setupAppTest } from '../../test-helpers.ts';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

const adminPatch = (id: string, body: unknown, adminKey: string) =>
  requestApp(`/api/keys/${id}`, {
    method: 'PATCH',
    headers: { 'x-api-key': adminKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('PATCH /api/keys/:id accepts a custom upstream whitelist + order', async () => {
  const { repo, apiKey, adminKey } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_x', name: 'X' }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_y', name: 'Y' }));

  const response = await adminPatch(apiKey.id, { upstream_ids: ['up_y', 'up_x'] }, adminKey);
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.upstream_ids, ['up_y', 'up_x']);

  const stored = await repo.apiKeys.getById(apiKey.id);
  assertExists(stored);
  assertEquals(stored.upstreamIds, ['up_y', 'up_x']);
});

test('PATCH /api/keys/:id resets to default with upstream_ids: null', async () => {
  const { repo, apiKey, adminKey } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_x', name: 'X' }));
  await adminPatch(apiKey.id, { upstream_ids: ['up_x'] }, adminKey);

  const response = await adminPatch(apiKey.id, { upstream_ids: null }, adminKey);
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.upstream_ids, null);

  const stored = await repo.apiKeys.getById(apiKey.id);
  assertExists(stored);
  assertEquals(stored.upstreamIds, null);
});

test('PATCH /api/keys/:id rejects an empty upstream_ids array', async () => {
  const { apiKey, adminKey } = await setupAppTest();
  const response = await adminPatch(apiKey.id, { upstream_ids: [] }, adminKey);
  assertEquals(response.status, 400);
});

test('PATCH /api/keys/:id rejects unknown upstream ids with a descriptive error', async () => {
  const { repo, apiKey, adminKey } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_known', name: 'Known' }));

  const response = await adminPatch(apiKey.id, { upstream_ids: ['up_known', 'up_ghost'] }, adminKey);
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(typeof body.error, 'string');
  if (!String(body.error).includes('up_ghost')) {
    throw new Error(`expected error to mention up_ghost; got ${body.error}`);
  }
});

test('PATCH /api/keys/:id rejects duplicate ids inside the whitelist', async () => {
  const { repo, apiKey, adminKey } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_x', name: 'X' }));
  const response = await adminPatch(apiKey.id, { upstream_ids: ['up_x', 'up_x'] }, adminKey);
  assertEquals(response.status, 400);
});

test('PATCH /api/keys/:id leaves name unchanged when only upstream_ids is sent', async () => {
  const { repo, apiKey, adminKey } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_x', name: 'X' }));
  await adminPatch(apiKey.id, { upstream_ids: ['up_x'] }, adminKey);

  const stored = await repo.apiKeys.getById(apiKey.id);
  assertExists(stored);
  assertEquals(stored.name, apiKey.name);
});

test('PATCH /api/keys/:id leaves upstream_ids unchanged (stale ids included) when only name is sent', async () => {
  const { repo, apiKey, adminKey } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_x', name: 'X' }));
  // Stale id surviving from a prior write; only touched by writes that target upstream_ids.
  await repo.apiKeys.save({ ...apiKey, upstreamIds: ['up_x', 'up_gone'] });

  const response = await adminPatch(apiKey.id, { name: 'renamed' }, adminKey);
  assertEquals(response.status, 200);
  const stored = await repo.apiKeys.getById(apiKey.id);
  assertExists(stored);
  assertEquals(stored.name, 'renamed');
  assertEquals(stored.upstreamIds, ['up_x', 'up_gone']);
});

test('PATCH /api/keys/:id drops stale ids from storage when upstream_ids is written', async () => {
  const { repo, apiKey, adminKey } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_known', name: 'Known' }));
  // up_gone refers to an upstream deleted earlier; cleanup runs at save time.
  await repo.apiKeys.save({ ...apiKey, upstreamIds: ['up_known', 'up_gone'] });

  const response = await adminPatch(apiKey.id, { upstream_ids: ['up_known'] }, adminKey);
  assertEquals(response.status, 200);
  const stored = await repo.apiKeys.getById(apiKey.id);
  assertExists(stored);
  assertEquals(stored.upstreamIds, ['up_known']);
});

test('PATCH /api/keys/:id is admin-only', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp(`/api/keys/${apiKey.id}`, {
    method: 'PATCH',
    headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'renamed' }),
  });
  assertEquals(response.status, 403);
});
