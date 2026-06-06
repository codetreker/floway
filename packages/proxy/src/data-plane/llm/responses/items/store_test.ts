import { test } from 'vitest';

import { createStoredResponsesItemId } from './format.ts';
import { createNonResponsesSourceStore, createResponsesHttpStore } from './store.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
import { assertEquals, assertExists } from '@floway-dev/test-utils';
import { responsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

const API_KEY_ID = 'key_stateful_store';

const storedRow = (overrides: Partial<StoredResponsesItem> & Pick<StoredResponsesItem, 'id' | 'itemType'>): StoredResponsesItem => ({
  apiKeyId: API_KEY_ID,
  upstreamId: null,
  upstreamItemId: null,
  origin: 'upstream',
  payload: { item: { type: overrides.itemType, id: overrides.id } },
  contentHash: null,
  encryptedContentHash: null,
  createdAt: 1_000,
  refreshedAt: 1_000,
  ...overrides,
});

test('snapshots with non-replayable metadata-only rows load as missing', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const missingPayload = storedRow({
    id: createStoredResponsesItemId('message'),
    itemType: 'message',
    origin: 'input',
    payload: null,
    createdAt: 1_000,
    refreshedAt: 1_000,
  });
  await repo.responsesItems.insertMany([missingPayload]);
  await repo.responsesSnapshots.insert({
    id: 'resp_expired',
    apiKeyId: API_KEY_ID,
    itemIds: [missingPayload.id],
    createdAt: 1_000,
    refreshedAt: 1_000,
  });

  const store = createResponsesHttpStore(API_KEY_ID, undefined);

  assertEquals(await store.loadSnapshot('resp_expired'), null);
});

test('snapshots with upstream-owned metadata-only rows remain replayable', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const upstreamOwned = storedRow({
    id: createStoredResponsesItemId('reasoning'),
    itemType: 'reasoning',
    upstreamId: 'up_a',
    upstreamItemId: 'raw_rs_a',
    payload: null,
    createdAt: 1_000,
    refreshedAt: 1_000,
  });
  await repo.responsesItems.insertMany([upstreamOwned]);
  await repo.responsesSnapshots.insert({
    id: 'resp_metadata',
    apiKeyId: API_KEY_ID,
    itemIds: [upstreamOwned.id],
    createdAt: 1_000,
    refreshedAt: 1_000,
  });

  const store = createResponsesHttpStore(API_KEY_ID, undefined);
  const snapshot = await store.loadSnapshot('resp_metadata');

  assertExists(snapshot);
  assertEquals(snapshot.itemIds, [upstreamOwned.id]);
});

test('createNonResponsesSourceStore reads items for affinity but does not write snapshots', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const item = storedRow({
    id: createStoredResponsesItemId('message'),
    itemType: 'message',
    upstreamId: 'up_a',
    upstreamItemId: 'raw_msg_a',
    createdAt: 1_000,
    refreshedAt: 1_000,
  });
  await repo.responsesItems.insertMany([item]);

  const store = createNonResponsesSourceStore(API_KEY_ID);

  // Items are still readable for affinity lookups.
  const input = [{ type: 'message', id: item.id, role: 'assistant', content: [] }] as unknown as ResponsesInputItem[];
  await store.loadInputItems({ sourceItems: input, view: responsesItemsView });
  assertExists(store.getItemById(item.id));

  // commitSnapshot is a no-op when snapshotWrites is empty.
  const outputItem: StoredResponsesItem = {
    ...item,
    id: createStoredResponsesItemId('message'),
    origin: 'upstream',
    payload: { item: { type: 'message', id: 'out_1', role: 'assistant', content: [] } },
  };
  store.beginAttempt([]);
  store.stageOutputItem(outputItem);
  await store.commitOutputItems();
  await store.commitSnapshot('resp_new', 'append');

  // No snapshot was written because snapshotWrites is empty for non-Responses sources.
  assertEquals(await repo.responsesSnapshots.lookup(API_KEY_ID, 'resp_new'), null);
});

test('createResponsesHttpStore with store=false does not write snapshots', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  const store = createResponsesHttpStore(API_KEY_ID, false);
  const outputItem: StoredResponsesItem = storedRow({
    id: createStoredResponsesItemId('message'),
    itemType: 'message',
    origin: 'upstream',
  });
  store.beginAttempt([]);
  store.stageOutputItem(outputItem);
  await store.commitOutputItems();
  await store.commitSnapshot('resp_no_store', 'append');

  assertEquals(await repo.responsesSnapshots.lookup(API_KEY_ID, 'resp_no_store'), null);
});

test('createResponsesHttpStore with store=true writes snapshots', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  const store = createResponsesHttpStore(API_KEY_ID, true);
  const outputItem: StoredResponsesItem = storedRow({
    id: createStoredResponsesItemId('message'),
    itemType: 'message',
    origin: 'upstream',
    upstreamId: 'up_snap',
    upstreamItemId: 'raw_snap',
    payload: { item: { type: 'message', id: 'snap_1', role: 'assistant', content: [] } },
  });
  store.beginAttempt([]);
  store.stageOutputItem(outputItem);
  await store.commitOutputItems();
  await store.commitSnapshot('resp_with_store', 'append');

  const snapshot = await repo.responsesSnapshots.lookup(API_KEY_ID, 'resp_with_store');
  assertExists(snapshot);
  assertEquals(snapshot.itemIds, [outputItem.id]);
});
