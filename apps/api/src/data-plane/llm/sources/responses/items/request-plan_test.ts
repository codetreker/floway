import { test } from 'vitest';

import { createStoredResponsesItemId, hashResponsesItemEncryptedContent, isStoredResponsesItemId } from './format.ts';
import {
  planResponsesItemProviders,
  prepareStoredResponsesItemsForSource,
  rewriteStoredResponsesItemsForProvider,
} from './request-plan.ts';
import { initRepo } from '../../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../../repo/memory.ts';
import type { StoredResponsesItem } from '../../../../../repo/types.ts';
import { assert, assertEquals, assertFalse } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel } from '../../../../../test-helpers.ts';
import type { ModelProviderInstance, ProviderModelRecord } from '../../../../providers/types.ts';
import { createHttpStatefulResponsesStore } from '../stateful-store.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
import { chatCompletionsViaResponsesItemsView, messagesViaResponsesItemsView, responsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

const packReasoningSignature = (id: string): string => `@${id}`;

const API_KEY_ID = 'key_test';

const provider = (upstream: string, supportsResponsesItemReference = true): ModelProviderInstance & ProviderModelRecord => {
  const upstreamModel = stubUpstreamModel();
  const modelProvider = stubProvider({
    getProvidedModels: () => Promise.resolve([upstreamModel]),
  });
  return {
    upstream,
    upstreamName: upstream,
    providerKind: 'custom',
    name: upstream,
    provider: modelProvider,
    upstreamModel,
    enabledFlags: upstreamModel.enabledFlags,
    disabledPublicModelIds: [],
    supportsResponsesItemReference,
  };
};

const insertRows = async (rows: readonly StoredResponsesItem[]) => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  await repo.responsesItems.insertMany(rows);
  return repo;
};

const prepareResponsesItems = async (sourceItems: string | readonly ResponsesInputItem[]) => {
  const store = createHttpStatefulResponsesStore(API_KEY_ID, undefined);
  await store.loadInputItems({ sourceItems, view: responsesItemsView });
  return await prepareStoredResponsesItemsForSource(sourceItems, responsesItemsView, store);
};

const rewriteResponsesItems = async (
  sourceItems: string | readonly ResponsesInputItem[],
  prepared: Awaited<ReturnType<typeof prepareResponsesItems>>,
  binding: ProviderModelRecord,
) => await rewriteStoredResponsesItemsForProvider(sourceItems, prepared, binding, responsesItemsView);

const prepareChatItems = async (messages: ChatCompletionsPayload['messages']) => {
  const store = createHttpStatefulResponsesStore(API_KEY_ID, undefined);
  await store.loadInputItems({ sourceItems: messages, view: chatCompletionsViaResponsesItemsView });
  return await prepareStoredResponsesItemsForSource(messages, chatCompletionsViaResponsesItemsView, store);
};

const rewriteChatItems = async (
  messages: ChatCompletionsPayload['messages'],
  prepared: Awaited<ReturnType<typeof prepareChatItems>>,
  binding: ProviderModelRecord,
) => await rewriteStoredResponsesItemsForProvider(messages, prepared, binding, chatCompletionsViaResponsesItemsView);

const prepareMessagesItems = async (messages: MessagesPayload['messages']) => {
  const store = createHttpStatefulResponsesStore(API_KEY_ID, undefined);
  await store.loadInputItems({ sourceItems: messages, view: messagesViaResponsesItemsView });
  return await prepareStoredResponsesItemsForSource(messages, messagesViaResponsesItemsView, store);
};

const rewriteMessagesItems = async (
  messages: MessagesPayload['messages'],
  prepared: Awaited<ReturnType<typeof prepareMessagesItems>>,
  binding: ProviderModelRecord,
) => await rewriteStoredResponsesItemsForProvider(messages, prepared, binding, messagesViaResponsesItemsView);

const storedRow = (
  overrides: Omit<Partial<StoredResponsesItem>, 'payload'> & Pick<StoredResponsesItem, 'id' | 'itemType'> & { payload?: unknown | null },
): StoredResponsesItem => {
  const { payload, ...rest } = overrides;
  return {
    apiKeyId: API_KEY_ID,
    upstreamId: null,
    upstreamItemId: null,
    origin: overrides.origin ?? (overrides.upstreamId === undefined || overrides.upstreamId === null ? 'synthetic' : 'upstream'),
    contentHash: null,
    encryptedContentHash: null,
    payload: payload === undefined || payload === null
      ? null
      : typeof payload === 'object' && Object.hasOwn(payload, 'item')
        ? payload as StoredResponsesItem['payload']
        : { item: payload },
    createdAt: 1_000,
    refreshedAt: 1_000,
    ...rest,
  };
};

const storedMessageId = (_label: string): string => createStoredResponsesItemId('message');

const storedReasoningId = (_label: string): string => createStoredResponsesItemId('reasoning');

const storedCompactionId = (_label: string): string => createStoredResponsesItemId('compaction');

test('missing stored item_reference returns a source-renderable not-found failure', async () => {
  await insertRows([]);
  const id = storedMessageId('missing');

  const prepared = await prepareResponsesItems([{ type: 'item_reference', id }]);
  const plan = planResponsesItemProviders([provider('up_a')], prepared);

  assertEquals(plan.type, 'failure');
  if (plan.type === 'failure') {
    assertEquals(plan.failure.kind, 'item-not-found');
    if (plan.failure.kind === 'item-not-found') assertEquals(plan.failure.itemId, id);
  }
});

test('invalid stored item_reference ids are not looked up as stored rows', async () => {
  const id = 'msg_AAAAAA_0xVvS8c_KjD1sBkZk5qbdA';
  await insertRows([
    storedRow({ id, itemType: 'message', upstreamId: 'up_a', upstreamItemId: 'raw_msg_a' }),
  ]);

  const prepared = await prepareResponsesItems([{ type: 'item_reference', id }]);
  const plan = planResponsesItemProviders([provider('up_a')], prepared);

  assertEquals(plan.type, 'failure');
  if (plan.type === 'failure') assertEquals(plan.failure.kind, 'item-not-found');
});

test('metadata-only item_reference without upstream affinity rejects instead of emitting a temporary reference', async () => {
  const id = storedMessageId('metadata-only-reference');
  await insertRows([
    storedRow({ id, itemType: 'message', upstreamId: null, upstreamItemId: null, payload: null }),
  ]);

  const prepared = await prepareResponsesItems([{ type: 'item_reference', id }]);
  const plan = planResponsesItemProviders([provider('up_a')], prepared);

  assertEquals(plan.type, 'failure');
  if (plan.type === 'failure') assertEquals(plan.failure.kind, 'item-not-found');
});

test('metadata-only item_reference with upstream affinity but no upstream item id rejects as not found', async () => {
  const id = storedMessageId('metadata-only-origin-reference');
  await insertRows([
    storedRow({ id, itemType: 'message', upstreamId: 'up_a', upstreamItemId: null, payload: null }),
  ]);

  const prepared = await prepareResponsesItems([{ type: 'item_reference', id }]);
  const plan = planResponsesItemProviders([provider('up_a')], prepared);

  assertEquals(plan.type, 'failure');
  if (plan.type === 'failure') assertEquals(plan.failure.kind, 'item-not-found');
});

test('ordinary non-carrier strings are ignored', async () => {
  await insertRows([]);
  const prepared = await prepareResponsesItems(storedMessageId('ordinary-string'));
  const plan = planResponsesItemProviders([provider('up_a'), provider('up_b')], prepared);

  assertEquals(prepared.references, []);
  assertEquals(plan.type, 'providers');
  if (plan.type === 'providers') assertEquals(plan.providers.map(item => item.upstream), ['up_a', 'up_b']);
});

test('duplicate stored ids dedupe preferred upstreams by last occurrence', async () => {
  const first = storedReasoningId('first');
  const second = storedReasoningId('second');
  await insertRows([
    storedRow({ id: first, itemType: 'reasoning', upstreamId: 'up_a', upstreamItemId: 'raw_rs_a' }),
    storedRow({ id: second, itemType: 'reasoning', upstreamId: 'up_b', upstreamItemId: 'raw_rs_b' }),
  ]);

  const prepared = await prepareResponsesItems([
    { type: 'reasoning', id: first, summary: [{ type: 'summary_text', text: 'first-old' }] },
    { type: 'reasoning', id: second, summary: [{ type: 'summary_text', text: 'second' }] },
    { type: 'reasoning', id: first, summary: [{ type: 'summary_text', text: 'first-new' }] },
  ]);

  assertEquals([...prepared.preferredUpstreamIds], ['up_b', 'up_a']);
});

test('mixed portable upstreams are ordered by reverse last occurrence before remaining providers', async () => {
  const first = storedReasoningId('first');
  const second = storedReasoningId('second');
  await insertRows([
    storedRow({ id: first, itemType: 'reasoning', upstreamId: 'up_a', upstreamItemId: 'raw_rs_a' }),
    storedRow({ id: second, itemType: 'reasoning', upstreamId: 'up_b', upstreamItemId: 'raw_rs_b' }),
  ]);

  const prepared = await prepareResponsesItems([
    { type: 'reasoning', id: first, summary: [{ type: 'summary_text', text: 'first' }] },
    { type: 'reasoning', id: second, summary: [{ type: 'summary_text', text: 'second' }] },
  ]);
  const plan = planResponsesItemProviders([provider('up_c'), provider('up_a'), provider('up_b')], prepared);

  assertEquals(plan.type, 'providers');
  if (plan.type === 'providers') assertEquals(plan.providers.map(item => item.upstream), ['up_b', 'up_a', 'up_c']);
});

test('conflicting compaction forcing upstreams reject the request', async () => {
  const first = storedCompactionId('first');
  const second = storedCompactionId('second');
  await insertRows([
    storedRow({ id: first, itemType: 'compaction', upstreamId: 'up_a', upstreamItemId: 'raw_cmp_a' }),
    storedRow({ id: second, itemType: 'compaction', upstreamId: 'up_b', upstreamItemId: 'raw_cmp_b' }),
  ]);

  const prepared = await prepareResponsesItems([
    { type: 'compaction', id: first },
    { type: 'compaction', id: second },
  ] as ResponsesInputItem[]);
  const plan = planResponsesItemProviders([provider('up_a'), provider('up_b')], prepared);

  assertEquals(plan.type, 'failure');
  if (plan.type === 'failure') assertEquals(plan.failure.kind, 'routing-unavailable');
});

test('matching upstream rewrites to upstream_item_id', async () => {
  const id = storedMessageId('origin');
  await insertRows([
    storedRow({ id, itemType: 'message', upstreamId: 'up_a', upstreamItemId: 'raw_msg_a' }),
  ]);

  const sourceItems: ResponsesInputItem[] = [{ type: 'message', id, role: 'assistant', content: 'stale' }];
  const prepared = await prepareResponsesItems(sourceItems);
  const rewritten = await rewriteResponsesItems(sourceItems, prepared, provider('up_a'));

  assertEquals(rewritten, [{ type: 'message', id: 'raw_msg_a', role: 'assistant', content: 'stale' }]);
});

test('non-matching reasoning is stripped from Chat reasoning_items', async () => {
  const id = storedReasoningId('reasoning');
  await insertRows([
    storedRow({ id, itemType: 'reasoning', upstreamId: 'up_a', upstreamItemId: 'raw_rs_a' }),
  ]);

  const messages: ChatCompletionsPayload['messages'] = [{
    role: 'assistant',
    content: null,
    reasoning_items: [{ type: 'reasoning', id, summary: [{ type: 'summary_text', text: 'trace' }] }],
  }];
  const prepared = await prepareChatItems(messages);
  const rewritten = await rewriteChatItems(messages, prepared, provider('up_b'));

  assertEquals(rewritten, [{ role: 'assistant', content: null, reasoning_items: null }]);
});

test('synthetic reasoning without an upstream owner is inline-expanded to any provider', async () => {
  const id = storedReasoningId('synthetic');
  await insertRows([
    // No upstream owner (translated from a non-Responses upstream): the row
    // carries its full payload and stays portable to any upstream, unlike an
    // upstream-owned reasoning row which is dropped when routed elsewhere.
    storedRow({
      id,
      itemType: 'reasoning',
      upstreamId: null,
      upstreamItemId: null,
      payload: { type: 'reasoning', id: 'rs_synthetic_origin', summary: [{ type: 'summary_text', text: 'trace' }] },
    }),
  ]);

  const messages: ChatCompletionsPayload['messages'] = [{
    role: 'assistant',
    content: null,
    reasoning_items: [{ type: 'reasoning', id, summary: [{ type: 'summary_text', text: 'trace' }] }],
  }];
  const prepared = await prepareChatItems(messages);
  const rewritten = await rewriteChatItems(messages, prepared, provider('up_b'));

  const items = (rewritten[0] as { reasoning_items?: { summary?: { text: string }[] }[] | null }).reasoning_items;
  assert(items?.length === 1, 'synthetic reasoning must survive routing to a non-owning provider');
  assertEquals(items[0].summary?.[0]?.text, 'trace');
});

test('row item type must match source item type before downgrade or rewrite', async () => {
  const reasoningId = storedReasoningId('wrong-type');
  await insertRows([
    storedRow({ id: reasoningId, itemType: 'reasoning', upstreamId: 'up_a', upstreamItemId: 'raw_rs_a' }),
  ]);

  const prepared = await prepareResponsesItems([
    { type: 'message', id: reasoningId, role: 'assistant', content: 'visible message' },
  ] as ResponsesInputItem[]);
  const plan = planResponsesItemProviders([provider('up_a')], prepared);

  assertEquals(plan.type, 'failure');
  if (plan.type === 'failure') assertEquals(plan.failure.kind, 'routing-unavailable');
});

test('matching upstream rewrites Chat reasoning_items to upstream reasoning id', async () => {
  const id = storedReasoningId('chat-origin');
  await insertRows([
    storedRow({ id, itemType: 'reasoning', upstreamId: 'up_a', upstreamItemId: 'raw_rs_a' }),
  ]);

  const messages: ChatCompletionsPayload['messages'] = [{
    role: 'assistant',
    content: null,
    reasoning_items: [{ type: 'reasoning', id, summary: [{ type: 'summary_text', text: 'trace' }] }],
  }];
  const prepared = await prepareChatItems(messages);
  const rewritten = await rewriteChatItems(messages, prepared, provider('up_a'));

  assertEquals(rewritten, [{
    role: 'assistant',
    content: null,
    reasoning_items: [{ type: 'reasoning', id: 'raw_rs_a', summary: [{ type: 'summary_text', text: 'trace' }] }],
  }]);
});

test('matching upstream rewrites Messages thinking signature to upstream reasoning id', async () => {
  const id = storedReasoningId('messages-origin');
  await insertRows([
    storedRow({ id, itemType: 'reasoning', upstreamId: 'up_a', upstreamItemId: 'raw_rs_a' }),
  ]);

  const messages: MessagesPayload['messages'] = [{
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'trace', signature: packReasoningSignature(id) },
      { type: 'text', text: 'visible' },
    ],
  }];
  const prepared = await prepareMessagesItems(messages);
  const rewritten = await rewriteMessagesItems(messages, prepared, provider('up_a'));

  assertEquals(rewritten, [{
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'trace', signature: packReasoningSignature('raw_rs_a') },
      { type: 'text', text: 'visible' },
    ],
  }]);
});

test('non-matching reasoning is stripped from Messages thinking signature carriers', async () => {
  const id = storedReasoningId('messages-strip');
  await insertRows([
    storedRow({ id, itemType: 'reasoning', upstreamId: 'up_a', upstreamItemId: 'raw_rs_a' }),
  ]);

  const messages: MessagesPayload['messages'] = [{
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'trace', signature: packReasoningSignature(id) },
      { type: 'text', text: 'visible' },
    ],
  }];
  const prepared = await prepareMessagesItems(messages);
  const rewritten = await rewriteMessagesItems(messages, prepared, provider('up_b'));

  assertEquals(rewritten, [{
    role: 'assistant',
    content: [{ type: 'text', text: 'visible' }],
  }]);
});

test('non-matching portable inline items get temporary ids without leaking raw upstream ids', async () => {
  const id = storedMessageId('portable');
  await insertRows([
    storedRow({ id, itemType: 'message', upstreamId: 'up_a', upstreamItemId: 'raw_msg_a' }),
  ]);

  const sourceItems: ResponsesInputItem[] = [{ type: 'message', id, role: 'assistant', content: 'portable body' }];
  const prepared = await prepareResponsesItems(sourceItems);
  const rewritten = await rewriteResponsesItems(sourceItems, prepared, provider('up_b')) as ResponsesInputItem[];
  const [item] = rewritten;

  assert(item.type === 'message');
  assert(typeof item.id === 'string');
  assert(item.id.startsWith('msg_tmp_'), item.id);
  assertFalse(isStoredResponsesItemId(item.id));
  assert(item.id !== id);
  assert(item.id !== 'raw_msg_a');
});

test('stored payload replaces stale caller content before provider id rewrite', async () => {
  const id = storedMessageId('canonical');
  await insertRows([
    storedRow({
      id,
      itemType: 'message',
      upstreamId: 'up_a',
      upstreamItemId: 'raw_msg_a',
      payload: {
        type: 'message',
        id,
        role: 'assistant',
        content: [{ type: 'output_text', text: 'canonical content' }],
      },
    }),
  ]);

  const sourceItems: ResponsesInputItem[] = [{ type: 'message', id, role: 'assistant', content: 'stale caller content' }];
  const prepared = await prepareResponsesItems(sourceItems);
  const rewritten = await rewriteResponsesItems(sourceItems, prepared, provider('up_a'));

  assertEquals(rewritten, [{
    type: 'message',
    id: 'raw_msg_a',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'canonical content' }],
  }]);
});

test('matching upstream keeps item_reference shape and rewrites to upstream item id', async () => {
  const id = storedMessageId('origin-reference');
  await insertRows([
    storedRow({
      id,
      itemType: 'message',
      upstreamId: 'up_a',
      upstreamItemId: 'raw_msg_a',
      payload: {
        type: 'message',
        id,
        role: 'assistant',
        content: [{ type: 'output_text', text: 'stored content' }],
      },
    }),
  ]);

  const sourceItems: ResponsesInputItem[] = [{ type: 'item_reference', id }];
  const prepared = await prepareResponsesItems(sourceItems);
  const rewritten = await rewriteResponsesItems(sourceItems, prepared, provider('up_a'));

  assertEquals(rewritten, [{ type: 'item_reference', id: 'raw_msg_a' }]);
});

test('matching upstream without item_reference support expands the stored item body', async () => {
  const id = storedMessageId('origin-reference-expanded');
  await insertRows([
    storedRow({
      id,
      itemType: 'message',
      upstreamId: 'up_a',
      upstreamItemId: 'raw_msg_a',
      payload: {
        type: 'message',
        id,
        role: 'assistant',
        content: [{ type: 'output_text', text: 'stored content' }],
      },
    }),
  ]);

  const sourceItems: ResponsesInputItem[] = [{ type: 'item_reference', id }];
  const prepared = await prepareResponsesItems(sourceItems);
  const rewritten = await rewriteResponsesItems(sourceItems, prepared, provider('up_a', false));

  assertEquals(rewritten, [{
    type: 'message',
    id: 'raw_msg_a',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'stored content' }],
  }]);
});

test('metadata-only item_reference rejects when the origin upstream does not support item_reference', async () => {
  const id = storedMessageId('metadata-only-reference-unsupported');
  await insertRows([
    storedRow({ id, itemType: 'message', upstreamId: 'up_a', upstreamItemId: 'raw_msg_a', payload: null }),
  ]);

  const prepared = await prepareResponsesItems([{ type: 'item_reference', id }]);
  const plan = planResponsesItemProviders([provider('up_a', false)], prepared);

  assertEquals(plan.type, 'failure');
  if (plan.type === 'failure') {
    assertEquals(plan.failure.kind, 'item-not-found');
    if (plan.failure.kind === 'item-not-found') assertEquals(plan.failure.itemId, id);
  }
});

test('id-less reasoning is matched by encrypted_content hash and prefers its owning upstream', async () => {
  const enc = 'enc-reasoning-blob';
  const hash = await hashResponsesItemEncryptedContent(enc);
  await insertRows([
    storedRow({ id: storedReasoningId('owned'), itemType: 'reasoning', upstreamId: 'up_a', upstreamItemId: 'raw_rs_a', encryptedContentHash: hash, payload: null }),
  ]);

  const items = [{ type: 'reasoning', summary: [], encrypted_content: enc }] as unknown as ResponsesInputItem[];
  const prepared = await prepareResponsesItems(items);
  const plan = planResponsesItemProviders([provider('up_b'), provider('up_a')], prepared);

  assertEquals(plan.type, 'providers');
  if (plan.type === 'providers') assertEquals(plan.providers.map(item => item.upstream), ['up_a', 'up_b']);

  // Routed to the owner: resolved to its stored row and stamped with the
  // upstream's own item id, the same as an id-bearing reference.
  assertEquals(await rewriteResponsesItems(items, prepared, provider('up_a')), [{ type: 'reasoning', summary: [], encrypted_content: enc, id: 'raw_rs_a' }]);
  // Routed elsewhere (owner unavailable): the blob would not verify, so the
  // reasoning item is dropped rather than carried.
  assertEquals(await rewriteResponsesItems(items, prepared, provider('up_b')), []);
});

test('matched stored items are refreshed when selected touches are flushed', async () => {
  const id = storedReasoningId('refresh');
  const repo = await insertRows([
    storedRow({ id, itemType: 'reasoning', upstreamId: 'up_a', upstreamItemId: 'raw_rs_a', payload: null, createdAt: 1_000, refreshedAt: 1_000 }),
  ]);
  const items = [{ type: 'item_reference', id }] as const;
  const store = createHttpStatefulResponsesStore(API_KEY_ID, undefined);

  await store.loadInputItems({ sourceItems: items, view: responsesItemsView });
  await prepareStoredResponsesItemsForSource(items, responsesItemsView, store);
  await store.refreshTouchedItems();

  const [row] = await repo.responsesItems.lookupMany(API_KEY_ID, [id]);
  assert(row.refreshedAt > 1_000);
});

test('id-less encrypted_content duplicate hash keeps the freshest stored row', async () => {
  const enc = 'duplicate-enc';
  const hash = await hashResponsesItemEncryptedContent(enc);
  await insertRows([
    storedRow({ id: storedReasoningId('old'), itemType: 'reasoning', upstreamId: 'up_old', upstreamItemId: 'raw_old', encryptedContentHash: hash, payload: null, createdAt: 1_000, refreshedAt: 1_000 }),
    storedRow({ id: storedReasoningId('new'), itemType: 'reasoning', upstreamId: 'up_new', upstreamItemId: 'raw_new', encryptedContentHash: hash, payload: null, createdAt: 2_000, refreshedAt: 2_000 }),
  ]);

  const items = [{ type: 'reasoning', summary: [], encrypted_content: enc }] as unknown as ResponsesInputItem[];
  const prepared = await prepareResponsesItems(items);
  const plan = planResponsesItemProviders([provider('up_old'), provider('up_new')], prepared);

  assertEquals(plan.type, 'providers');
  if (plan.type === 'providers') assertEquals(plan.providers.map(item => item.upstream), ['up_new', 'up_old']);
  assertEquals(await rewriteResponsesItems(items, prepared, provider('up_new')), [{ type: 'reasoning', summary: [], encrypted_content: enc, id: 'raw_new' }]);
});

test('id-less compaction is matched by encrypted_content hash and forces its owning upstream', async () => {
  const enc = 'enc-compaction-blob';
  const hash = await hashResponsesItemEncryptedContent(enc);
  await insertRows([
    storedRow({ id: storedCompactionId('owned'), itemType: 'compaction', upstreamId: 'up_a', upstreamItemId: 'raw_cmp_a', encryptedContentHash: hash, payload: null }),
  ]);

  const items = [{ type: 'compaction', encrypted_content: enc }] as unknown as ResponsesInputItem[];
  const prepared = await prepareResponsesItems(items);

  const plan = planResponsesItemProviders([provider('up_b'), provider('up_a')], prepared);
  assertEquals(plan.type, 'providers');
  if (plan.type === 'providers') assertEquals(plan.providers.map(item => item.upstream), ['up_a']);

  const gone = planResponsesItemProviders([provider('up_b')], prepared);
  assertEquals(gone.type, 'failure');
  if (gone.type === 'failure') assertEquals(gone.failure.kind, 'routing-unavailable');

  // At the forced owner the compaction is stamped with the upstream's item id.
  assertEquals(await rewriteResponsesItems(items, prepared, provider('up_a')), [{ type: 'compaction', encrypted_content: enc, id: 'raw_cmp_a' }]);
});

test('id-less encrypted_content skips fresher incompatible hash candidates', async () => {
  const enc = 'shared-encrypted-content';
  const hash = await hashResponsesItemEncryptedContent(enc);
  const incompatible = storedRow({
    id: storedMessageId('incompatible'),
    itemType: 'message',
    upstreamId: 'up_b',
    upstreamItemId: 'raw_msg_b',
    encryptedContentHash: hash,
    createdAt: 3_000,
    refreshedAt: 3_000,
  });
  const compatible = storedRow({
    id: storedReasoningId('compatible'),
    itemType: 'reasoning',
    upstreamId: 'up_a',
    upstreamItemId: 'raw_rs_a',
    encryptedContentHash: hash,
    createdAt: 2_000,
    refreshedAt: 2_000,
  });
  await insertRows([compatible, incompatible]);

  const items = [{ type: 'reasoning', encrypted_content: enc, summary: [] }] as unknown as ResponsesInputItem[];
  const prepared = await prepareResponsesItems(items);

  assertEquals(prepared.references[0].row?.id, compatible.id);
  assertEquals(await rewriteResponsesItems(items, prepared, provider('up_a')), [{ type: 'reasoning', encrypted_content: enc, summary: [], id: 'raw_rs_a' }]);
});

test('id-less encrypted_content with no stored match is a benign passthrough', async () => {
  await insertRows([]);
  const items = [{ type: 'reasoning', summary: [], encrypted_content: 'never-stored' }] as unknown as ResponsesInputItem[];
  const prepared = await prepareResponsesItems(items);

  assertEquals(prepared.failures, []);
  assertEquals(prepared.references, [{ type: 'reasoning', encryptedContent: 'never-stored' }]);

  const plan = planResponsesItemProviders([provider('up_a'), provider('up_b')], prepared);
  assertEquals(plan.type, 'providers');
  if (plan.type === 'providers') assertEquals(plan.providers.map(item => item.upstream), ['up_a', 'up_b']);

  assertEquals(await rewriteResponsesItems(items, prepared, provider('up_a')), items);
});
