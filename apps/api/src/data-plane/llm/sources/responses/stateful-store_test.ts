import { test } from 'vitest';

import { createStoredResponsesItemId, hashResponsesItemEncryptedContent } from './items/format.ts';
import { prepareStoredResponsesItemsForSource } from './items/request-plan.ts';
import { createHttpStatefulResponsesStore, createWebSocketStatefulResponsesSession } from './stateful-store.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';
import { assertEquals, assertExists } from '../../../../test-assert.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
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

test('encrypted-content lookup refreshes only the selected compatible candidate', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const encryptedContent = 'shared-encrypted-content';
  const encryptedContentHash = await hashResponsesItemEncryptedContent(encryptedContent);
  const compatible = storedRow({
    id: createStoredResponsesItemId('reasoning'),
    itemType: 'reasoning',
    upstreamId: 'up_a',
    upstreamItemId: 'raw_rs_a',
    encryptedContentHash,
    createdAt: 2_000,
    refreshedAt: 2_000,
  });
  const incompatible = storedRow({
    id: createStoredResponsesItemId('message'),
    itemType: 'message',
    upstreamId: 'up_b',
    upstreamItemId: 'raw_msg_b',
    encryptedContentHash,
    createdAt: 3_000,
    refreshedAt: 3_000,
  });
  await repo.responsesItems.insertMany([compatible, incompatible]);

  const input = [{ type: 'reasoning', encrypted_content: encryptedContent, summary: [] }] as unknown as ResponsesInputItem[];
  const store = createHttpStatefulResponsesStore(API_KEY_ID, undefined);
  await store.loadInputItems({ sourceItems: input, view: responsesItemsView });
  await prepareStoredResponsesItemsForSource(input, responsesItemsView, store);
  await store.refreshTouchedItems();

  const [readCompatible, readIncompatible] = await repo.responsesItems.lookupMany(API_KEY_ID, [compatible.id, incompatible.id]);
  assertExists(readCompatible);
  assertExists(readIncompatible);
  assertEquals(readCompatible.refreshedAt > compatible.refreshedAt, true);
  assertEquals(readIncompatible.refreshedAt, incompatible.refreshedAt);
});

test('websocket local incompatible encrypted-content candidates do not mask durable compatible rows', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const encryptedContent = 'websocket-shared-encrypted-content';
  const encryptedContentHash = await hashResponsesItemEncryptedContent(encryptedContent);
  const localIncompatible = storedRow({
    id: createStoredResponsesItemId('message'),
    itemType: 'message',
    upstreamId: 'up_local',
    upstreamItemId: 'raw_msg_local',
    encryptedContentHash,
    createdAt: 3_000,
    refreshedAt: 3_000,
  });
  const durableCompatible = storedRow({
    id: createStoredResponsesItemId('reasoning'),
    itemType: 'reasoning',
    upstreamId: 'up_durable',
    upstreamItemId: 'raw_rs_durable',
    encryptedContentHash,
    createdAt: 2_000,
    refreshedAt: 2_000,
  });
  await repo.responsesItems.insertMany([durableCompatible]);
  const session = createWebSocketStatefulResponsesSession();
  const localStore = session.createStore(API_KEY_ID, false).statefulResponsesStore;
  localStore.stageOutputItem(localIncompatible);
  await localStore.commitOutputItems();

  const input = [{ type: 'reasoning', encrypted_content: encryptedContent, summary: [] }] as unknown as ResponsesInputItem[];
  const store = session.createStore(API_KEY_ID, undefined).statefulResponsesStore;
  await store.loadInputItems({ sourceItems: input, view: responsesItemsView });
  const prepared = await prepareStoredResponsesItemsForSource(input, responsesItemsView, store);

  assertEquals(prepared.references[0].row?.id, durableCompatible.id);
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

  const store = createHttpStatefulResponsesStore(API_KEY_ID, undefined);

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

  const store = createHttpStatefulResponsesStore(API_KEY_ID, undefined);
  const snapshot = await store.loadSnapshot('resp_metadata');

  assertExists(snapshot);
  assertEquals(snapshot.itemIds, [upstreamOwned.id]);
});
