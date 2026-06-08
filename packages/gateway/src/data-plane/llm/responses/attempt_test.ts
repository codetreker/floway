import { test, vi } from 'vitest';

import { responsesAttempt } from './attempt.ts';
import { createStoredResponsesItemId, isStoredResponseId } from './items/format.ts';
import * as outputModule from './items/output.ts';
import { createResponsesHttpStore } from './items/store.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import type { StoredResponsesItem } from '../../../repo/types.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesPayload, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubUpstreamModel } from '@floway-dev/test-utils';

const API_KEY_ID = 'key_attempt_test';

const makeGatewayCtx = (): GatewayCtx => ({
  apiKeyId: API_KEY_ID,
  apiKeyUpstreamIds: null,
  wantsStream: true,
  scheduleBackground: () => {},
  requestStartedAt: 0,
});

const makePayload = (overrides: Partial<ResponsesPayload> = {}): ResponsesPayload => ({
  model: 'test-model',
  input: 'hello',
  ...overrides,
});

const makeResponsesResult = (id = 'resp_test'): ResponsesResult => ({
  id,
  object: 'response',
  model: 'test-model',
  status: 'completed',
  output: [{
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'hi' }],
  }],
  output_text: 'hi',
  error: null,
  incomplete_details: null,
});

const makeProviderEvents = async function* (events: readonly ResponsesStreamEvent[]): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (callResponses: (model: unknown, body: unknown, signal?: AbortSignal, headers?: Record<string, string>) => Promise<ProviderStreamResult<ResponsesStreamEvent>>): ProviderCandidate => {
  const upstreamModel = stubUpstreamModel();
  const provider = stubProvider({
    callResponses: (model, body, signal, headers) => callResponses(model, body, signal, headers),
  });
  return {
    provider: {
      upstream: 'up_test',
      providerKind: 'custom',
      name: 'up_test',
      disabledPublicModelIds: [],
      provider,
      supportsResponsesItemReference: true,
    },
    binding: {
      upstream: 'up_test',
      upstreamName: 'up_test',
      providerKind: 'custom',
      provider,
      upstreamModel,
      enabledFlags: upstreamModel.enabledFlags,
      supportsResponsesItemReference: true,
    },
    targetApi: 'responses',
  };
};

const makeCompactCandidate = (callResponsesCompact: (...args: unknown[]) => Promise<unknown>): ProviderCandidate => {
  const upstreamModel = stubUpstreamModel();
  const provider = stubProvider({
    callResponsesCompact: callResponsesCompact as never,
  });
  return {
    provider: {
      upstream: 'up_test',
      providerKind: 'custom',
      name: 'up_test',
      disabledPublicModelIds: [],
      provider,
      supportsResponsesItemReference: true,
    },
    binding: {
      upstream: 'up_test',
      upstreamName: 'up_test',
      providerKind: 'custom',
      provider,
      upstreamModel,
      enabledFlags: upstreamModel.enabledFlags,
      supportsResponsesItemReference: true,
    },
    targetApi: 'responses',
  };
};

const collectEvents = async (events: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>): Promise<ResponsesStreamEvent[]> => {
  const out: ResponsesStreamEvent[] = [];
  for await (const frame of events) {
    if (frame.type === 'event') out.push(frame.event);
  }
  return out;
};

const installRepo = () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return repo;
};

const insertStoredItem = async (repo: InMemoryRepo, overrides: Partial<StoredResponsesItem> & Pick<StoredResponsesItem, 'id' | 'itemType'>): Promise<StoredResponsesItem> => {
  const row: StoredResponsesItem = {
    apiKeyId: API_KEY_ID,
    upstreamId: null,
    upstreamItemId: null,
    origin: 'synthetic',
    contentHash: null,
    encryptedContentHash: null,
    payload: null,
    createdAt: 1_000,
    refreshedAt: 1_000,
    ...overrides,
  };
  await repo.responsesItems.insertMany([row]);
  return row;
};

test('generate native success wraps the upstream event stream once', async () => {
  installRepo();
  const wrapSpy = vi.spyOn(outputModule, 'wrapResponsesOutputForStorage');

  const completedEvent: ResponsesStreamEvent = {
    type: 'response.completed',
    sequence_number: 0,
    response: makeResponsesResult(),
  };
  const callResponses = vi.fn(async (): Promise<ProviderStreamResult<ResponsesStreamEvent>> => ({
    ok: true,
    events: makeProviderEvents([completedEvent]),
    modelKey: 'test-model-key',
  }));

  const candidate = makeCandidate(callResponses);
  const ctx = makeGatewayCtx();
  const store = createResponsesHttpStore(API_KEY_ID, true);

  const result = await responsesAttempt.generate({
    payload: makePayload(),
    ctx,
    store,
    candidate,
    snapshotMode: 'append',
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');

  // Drain so the wrapped pipeline runs and storage callbacks fire.
  const events = await collectEvents(result.events);
  assert(events.length >= 1, 'expected at least the response.completed event');

  assertEquals(callResponses.mock.calls.length, 1);
  assertEquals(wrapSpy.mock.calls.length, 1);
  const wrapArgs = wrapSpy.mock.calls[0][1];
  assertEquals(wrapArgs.snapshotMode, 'append');
  assertEquals(wrapArgs.upstream, 'up_test');
  assertEquals(wrapArgs.targetApi, 'responses');

  wrapSpy.mockRestore();
});

test('generate returns failure when rewrite throws item-not-found', async () => {
  installRepo();
  const callResponses = vi.fn(async (): Promise<ProviderStreamResult<ResponsesStreamEvent>> => {
    throw new Error('callResponses should not be called when rewrite fails');
  });
  const candidate = makeCandidate(callResponses);
  // Force `supportsResponsesItemReference: false` so a stored row with no
  // inline payload triggers the rewrite-side throw.
  candidate.binding.supportsResponsesItemReference = false;

  const missingId = createStoredResponsesItemId('message');
  // Pre-seed the store cache: a row with no inline payload, referenced as
  // `item_reference`. The store will resolve the id, and rewrite will throw
  // because the candidate cannot accept `item_reference`.
  const store = createResponsesHttpStore(API_KEY_ID, true);
  // Insert into the underlying repo so `loadInputItems` populates the cache.
  // The store uses `getRepo()` lazily, so the repo installed via `installRepo`
  // already feeds this lookup.
  const repo = installRepo();
  await insertStoredItem(repo, { id: missingId, itemType: 'message', payload: null });
  await store.loadInputItems({
    sourceItems: [{ type: 'item_reference' as const, id: missingId }],
    view: {
      visitAsResponsesItems: async (items, visit) => {
        for (const item of items as readonly { id: string }[]) await visit({ type: 'item_reference', id: item.id });
      },
    },
  });

  const result = await responsesAttempt.generate({
    payload: makePayload({ input: [{ type: 'item_reference', id: missingId }] }),
    ctx: makeGatewayCtx(),
    store,
    candidate,
    snapshotMode: 'append',
  });

  assertEquals(result.type, 'upstream-error');
  if (result.type !== 'upstream-error') throw new Error('unreachable');
  assertEquals(result.status, 404);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.error.code, null);
  assertEquals(body.error.message, `Item with id '${missingId}' not found.`);
  assertEquals(callResponses.mock.calls.length, 0);
});

test('generate passes non-events provider result through unchanged', async () => {
  installRepo();
  const wrapSpy = vi.spyOn(outputModule, 'wrapResponsesOutputForStorage');

  const upstreamResponse = new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 502, headers: { 'content-type': 'application/json' } });
  const callResponses = vi.fn(async (): Promise<ProviderStreamResult<ResponsesStreamEvent>> => ({
    ok: false,
    response: upstreamResponse,
    modelKey: 'test-model-key',
  }));

  const candidate = makeCandidate(callResponses);
  const result = await responsesAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
    candidate,
    snapshotMode: 'append',
  });

  assertEquals(result.type, 'upstream-error');
  if (result.type !== 'upstream-error') throw new Error('unreachable');
  assertEquals(result.status, 502);
  // Wrap must not run when the upstream failed before any events flowed.
  assertEquals(wrapSpy.mock.calls.length, 0);
  wrapSpy.mockRestore();
});

test('compact reshapes the trigger turn into a result and forwards snapshotMode=replace', async () => {
  installRepo();
  const wrapSpy = vi.spyOn(outputModule, 'wrapResponsesOutputForStorage');

  // Native /responses/compact returns a fully-shaped compaction envelope —
  // `provider.callResponsesCompact` already does the Copilot
  // compaction_trigger reshape internally — so the attempt receives a
  // ResponsesResult, expands it into synthetic frames, and wraps the
  // output for storage.
  const compactionItem = {
    type: 'compaction' as const,
    id: 'cmp_1',
    encrypted_content: 'ENC',
  };
  const compactionResult: ResponsesResult = {
    ...makeResponsesResult(),
    object: 'response.compaction',
    // Cast: `compaction` is an input-shaped item type the protocol's
    // ResponsesResult.output type does not include but the runtime accepts.
    output: [compactionItem] as unknown as ResponsesResult['output'],
  };

  const callResponsesCompact = vi.fn(async () => ({
    ok: true as const,
    result: compactionResult,
    modelKey: 'test-model-key',
  }));

  const candidate = makeCompactCandidate(callResponsesCompact);
  const result = await responsesAttempt.compact({
    payload: makePayload({
      input: [
        { type: 'message', role: 'user', content: 'kept message' },
      ],
    }),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
    candidate,
  });

  assertEquals(result.type, 'result');
  if (result.type !== 'result') throw new Error('unreachable');
  assertEquals(result.result.object, 'response.compaction');
  assertEquals(result.result.output.length, 1);
  assertEquals((result.result.output[0] as { id: string }).id, 'cmp_1');
  // The compact result wears a floway-minted response id, not the upstream's
  // — same id wrap committed the snapshot under.
  assert(isStoredResponseId(result.result.id));

  // wrap-output-storage runs exactly once on the synthesized compaction
  // events, with snapshotMode='replace'.
  assertEquals(wrapSpy.mock.calls.length, 1);
  assertEquals(wrapSpy.mock.calls[0][1].snapshotMode, 'replace');
  assertEquals(wrapSpy.mock.calls[0][1].targetApi, 'responses');

  wrapSpy.mockRestore();
});

// In-attempt test asserting the narrow header-inheritance contract: when an
// outer protocol passes invocation headers, the translated Messages call sees
// them on the wire.
test('generate inherits invocation headers across translation to Messages', async () => {
  installRepo();
  let observedHeaders: Record<string, string> | undefined;
  const upstreamModel = stubUpstreamModel();
  const messagesProvider = stubProvider({
    callMessages: async (_model, _body, _signal, headers): Promise<ProviderStreamResult<MessagesStreamEvent>> => {
      observedHeaders = headers;
      return {
        ok: true,
        events: (async function* () {
          yield eventFrame<MessagesStreamEvent>({
            type: 'message_start',
            message: {
              id: 'msg_1', type: 'message', role: 'assistant', content: [],
              model: 'test-model', stop_reason: null, stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          });
          yield eventFrame<MessagesStreamEvent>({ type: 'message_stop' });
          yield doneFrame();
        })(),
        modelKey: 'k',
      };
    },
  });
  const candidate: ProviderCandidate = {
    provider: {
      upstream: 'up_test', providerKind: 'custom', name: 'up_test',
      disabledPublicModelIds: [], provider: messagesProvider, supportsResponsesItemReference: true,
    },
    binding: {
      upstream: 'up_test', upstreamName: 'up_test', providerKind: 'custom',
      provider: messagesProvider, upstreamModel,
      enabledFlags: upstreamModel.enabledFlags, supportsResponsesItemReference: true,
    },
    targetApi: 'messages',
  };

  const result = await responsesAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
    candidate,
    snapshotMode: 'append',
    inheritedInvocationHeaders: { 'x-test': 'abc' },
  });
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(observedHeaders?.['x-test'], 'abc');
});

test('generate seeds store.privatePayload from rewrite references so cross-turn shims can replay', async () => {
  const repo = installRepo();

  // A stored web_search_call row whose payload carries `private` — the
  // payload kind the web-search shim relies on at cross-turn replay time.
  const wireId = createStoredResponsesItemId('web_search_call');
  await insertStoredItem(repo, {
    id: wireId,
    itemType: 'web_search_call',
    origin: 'upstream',
    payload: {
      item: {
        type: 'web_search_call',
        id: wireId,
        status: 'completed',
        action: { type: 'search', query: 'previous query' },
      },
      private: { kind: 'web-search-call', marker: 'seeded' },
    },
  });

  // Echo the stored item in the input — this is what a follow-up turn from a
  // stateless client looks like.
  const completedEvent: ResponsesStreamEvent = {
    type: 'response.completed',
    sequence_number: 0,
    response: makeResponsesResult(),
  };
  const callResponses = vi.fn(async (): Promise<ProviderStreamResult<ResponsesStreamEvent>> => ({
    ok: true,
    events: makeProviderEvents([completedEvent]),
    modelKey: 'test-model-key',
  }));
  const candidate = makeCandidate(callResponses);
  const store = createResponsesHttpStore(API_KEY_ID, true);

  // Populate the store cache the same way affinity-classified turns do, so
  // the rewriter can resolve the echoed item against the stored row.
  await store.loadInputItems({
    sourceItems: [{ type: 'web_search_call', id: wireId } as unknown as { id: string }],
    view: {
      visitAsResponsesItems: async (items, visit) => {
        for (const item of items as readonly { id: string }[]) {
          await visit({ type: 'web_search_call', id: item.id } as unknown as never);
        }
      },
    },
  });

  // Before generate runs, no per-attempt seed exists.
  assertEquals(store.getPrivatePayload(wireId), undefined);

  const result = await responsesAttempt.generate({
    payload: makePayload({
      input: [{ type: 'web_search_call', id: wireId } as unknown as never],
    }),
    ctx: makeGatewayCtx(),
    store,
    candidate,
    snapshotMode: 'append',
  });
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);

  // beginAttempt should have re-seeded privatePayload from the rewrite
  // references — keyed by the wire id the stored payload.item carries.
  const seeded = store.getPrivatePayload(wireId);
  assert(seeded !== undefined, 'privatePayload must be seeded after rewrite');
  assertEquals((seeded as { marker: string }).marker, 'seeded');
});
