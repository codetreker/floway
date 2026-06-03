import { test } from 'vitest';

import { createStoredResponsesItemId } from './format.ts';
import { prepareStoredResponsesItemsForSource, rewriteStoredResponsesItemsForProvider } from './request-plan.ts';
import { initRepo } from '../../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../../repo/memory.ts';
import type { StoredResponsesItem } from '../../../../../repo/types.ts';
import { assert, assertEquals } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel } from '../../../../../test-helpers.ts';
import type { ModelProviderInstance, ProviderModelRecord } from '../../../../providers/types.ts';
import { collectImageSources } from '../interceptors/server-tools/image-generation.ts';
import { createHttpStatefulResponsesStore } from '../stateful-store.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
import { responsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

const API_KEY_ID = 'key_test';
const PNG_B64 = 'aGVsbG8='; // "hello"

const provider = (upstream: string): ModelProviderInstance & ProviderModelRecord => {
  const upstreamModel = stubUpstreamModel();
  return {
    upstream,
    upstreamName: upstream,
    providerKind: 'custom',
    name: upstream,
    provider: stubProvider({ getProvidedModels: () => Promise.resolve([upstreamModel]) }),
    upstreamModel,
    enabledFlags: upstreamModel.enabledFlags,
    disabledPublicModelIds: [],
    supportsResponsesItemReference: true,
  };
};

// Confirms the image_generation shim gets cross-request editing "for free" from
// the stored-items layer: a synthesized image_generation_call persists as a
// portable row, and a later request that echoes only its id is inline-expanded
// back to the full item (result bytes included) before the source interceptors
// run — so collectImageSources can bind the prior image as an edit source.
test('a stored image_generation_call referenced by id is inline-expanded with its bytes and becomes editable', async () => {
  const storedId = createStoredResponsesItemId('image_generation_call');
  const row: StoredResponsesItem = {
    id: storedId,
    apiKeyId: API_KEY_ID,
    upstreamId: null, // synthetic / portable — no upstream owns it
    upstreamItemId: null,
    itemType: 'image_generation_call',
    origin: 'synthetic',
    payload: { item: { type: 'image_generation_call', id: storedId, status: 'completed', result: PNG_B64, revised_prompt: 'a cat', output_format: 'png' } },
    contentHash: null,
    encryptedContentHash: null,
    createdAt: Date.now(),
    refreshedAt: Date.now(),
  };
  const repo = new InMemoryRepo();
  initRepo(repo);
  await repo.responsesItems.insertMany([row]);

  // The client echoes only the id back, with the bytes stripped.
  const input: ResponsesInputItem[] = [{ type: 'image_generation_call', id: storedId, status: 'completed' } as ResponsesInputItem];

  const store = createHttpStatefulResponsesStore(API_KEY_ID, undefined);
  await store.loadInputItems({ sourceItems: input, view: responsesItemsView });
  const prepared = await prepareStoredResponsesItemsForSource(input, responsesItemsView, store);
  assertEquals(prepared.failures.length, 0);
  const expanded = await rewriteStoredResponsesItemsForProvider(input, prepared, provider('up'), responsesItemsView) as ResponsesInputItem[];

  // The bytes are restored on the expanded item...
  const igc = expanded[0] as { type: string; result?: string };
  assertEquals(igc.type, 'image_generation_call');
  assertEquals(igc.result, PNG_B64);

  // ...so the shim binds the prior image as an edit source on this next request.
  const sources = collectImageSources(expanded);
  assertEquals(sources.length, 1);
  assert(sources[0].bytes.byteLength > 0);
});
