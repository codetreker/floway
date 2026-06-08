import { test, vi } from 'vitest';

import { isStoredResponsesItemId } from './format.ts';
import { drainAsync, syntheticEventsFromResult, wrapResponsesOutputForStorage } from './output.ts';
import { createResponsesHttpStore, LayeredStatefulResponsesStore, RepoStatefulResponsesBacking, type StatefulResponsesBacking } from './store.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import type { ResponsesItemsRepo, StoredResponsesItem } from '../../../../repo/types.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesOutputItem, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { assert, assertEquals } from '@floway-dev/test-utils';

const apiKeyId = 'key_output_new';

const makeStore = (overrides: { store?: boolean; syntheticItemIds?: Iterable<string>; privatePayloads?: Iterable<readonly [string, unknown]> } = {}) => {
  const store = createResponsesHttpStore(apiKeyId, overrides.store);
  if (overrides.syntheticItemIds) {
    for (const id of overrides.syntheticItemIds) {
      const privatePayload = overrides.privatePayloads
        ? [...overrides.privatePayloads].find(([k]) => k === id)?.[1]
        : undefined;
      store.addSyntheticItem(id, privatePayload);
    }
  }
  return store;
};

const messageItem = (id: string, text: string): Extract<ResponsesOutputItem, { type: 'message' }> => ({
  type: 'message',
  id,
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text }],
});

const response = (output: ResponsesOutputItem[], status: ResponsesResult['status'] = 'completed'): ResponsesResult => ({
  id: 'resp_test',
  object: 'response',
  model: 'gpt-test',
  status,
  output,
  output_text: '',
  error: status === 'failed' ? { message: 'failed', code: 'server_error' } : null,
  incomplete_details: null,
});

const framesFrom = async function* (events: readonly ResponsesStreamEvent[]) {
  for (const event of events) yield eventFrame(event);
};

const TEST_RESPONSE_ID = 'resp_test123';

const wrap = (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  overrides: Parameters<typeof makeStore>[0] = {},
  extra: { snapshotMode?: 'none' | 'append' | 'replace'; targetApi?: 'responses' | 'messages' | 'chat-completions'; responseId?: string } = {},
) => {
  const store = makeStore(overrides);
  return {
    events: wrapResponsesOutputForStorage(frames, {
      store,
      upstream: 'up_native',
      snapshotMode: extra.snapshotMode ?? 'none',
      targetApi: extra.targetApi ?? 'responses',
      responseId: extra.responseId ?? TEST_RESPONSE_ID,
    }),
    store,
  };
};

const wrapWithStore = (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  store: ReturnType<typeof createResponsesHttpStore>,
  extra: { snapshotMode?: 'none' | 'append' | 'replace'; targetApi?: 'responses' | 'messages' | 'chat-completions'; upstream?: string; responseId?: string } = {},
) => wrapResponsesOutputForStorage(frames, {
  store,
  upstream: extra.upstream ?? 'up_native',
  snapshotMode: extra.snapshotMode ?? 'none',
  targetApi: extra.targetApi ?? 'responses',
  responseId: extra.responseId ?? TEST_RESPONSE_ID,
});

const collectEvents = async (events: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>): Promise<ResponsesStreamEvent[]> => {
  const collected: ResponsesStreamEvent[] = [];
  for await (const item of events) {
    if (item.type === 'event') collected.push(item.event);
  }
  return collected;
};

const eventAt = <TType extends ResponsesStreamEvent['type']>(
  events: readonly ResponsesStreamEvent[],
  type: TType,
): Extract<ResponsesStreamEvent, { type: TType }> => {
  const event = events.find((candidate): candidate is Extract<ResponsesStreamEvent, { type: TType }> => candidate.type === type);
  assert(event, `expected ${type}`);
  return event;
};

type IteratorResultPromise = Promise<IteratorResult<ProtocolFrame<ResponsesStreamEvent>>>;

const promiseStateAfterMicrotasks = async (promise: IteratorResultPromise): Promise<'pending' | 'fulfilled' | 'rejected'> => {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  promise.then(
    () => { state = 'fulfilled'; },
    () => { state = 'rejected'; },
  );
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
    if (state !== 'pending') return state;
  }
  return state;
};

const waitForInsertCall = async (repo: ControlledResponsesItemsRepo): Promise<void> => {
  for (let i = 0; i < 50; i += 1) {
    if (repo.calls.length > 0) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('timed out waiting for insertMany');
};

class ControlledResponsesItemsRepo implements ResponsesItemsRepo {
  calls: StoredResponsesItem[][] = [];
  resolveInsert: (() => void) | undefined;
  rejectInsert: ((error: unknown) => void) | undefined;

  lookupMany(): Promise<StoredResponsesItem[]> { return Promise.resolve([]); }
  lookupManyByEncryptedContentHash(): Promise<StoredResponsesItem[]> { return Promise.resolve([]); }
  lookupManyByContentHash(): Promise<StoredResponsesItem[]> { return Promise.resolve([]); }

  insertMany(items: readonly StoredResponsesItem[]): Promise<void> {
    this.calls.push(items.map(item => structuredClone(item)));
    return new Promise((resolve, reject) => {
      this.resolveInsert = resolve;
      this.rejectInsert = reject;
    });
  }

  fillPayloads(): Promise<number> { return Promise.resolve(0); }
  refreshMany(): Promise<number> { return Promise.resolve(0); }
  clearPayloadOlderThan(): Promise<number> { return Promise.resolve(0); }
  deleteOlderThan(): Promise<number> { return Promise.resolve(0); }
  deleteAll(): Promise<void> { return Promise.resolve(); }
}

test('rewrites output item ids consistently across added, child, done, and terminal', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_msg_native', 'hello');

  const { events } = wrap(framesFrom([
    { type: 'response.output_item.added', output_index: 0, item: { ...original, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: original.id!, delta: 'hello' },
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: response([original]) },
  ]));

  const collected = await collectEvents(events);
  const storedId = eventAt(collected, 'response.output_item.done').item.id!;
  assert(isStoredResponsesItemId(storedId));
  assert(storedId.startsWith('msg_'));
  assertEquals(eventAt(collected, 'response.output_item.added').item.id, storedId);
  assertEquals(eventAt(collected, 'response.output_text.delta').item_id, storedId);
  assertEquals(eventAt(collected, 'response.completed').response.output[0].id, storedId);

  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(row.upstreamId, 'up_native');
  assertEquals(row.upstreamItemId, original.id);
  assertEquals(row.payload, { item: original });
});

test('persists each row before yielding the item-done frame', async () => {
  const repo = new InMemoryRepo();
  const controlled = new ControlledResponsesItemsRepo();
  repo.responsesItems = controlled;
  initRepo(repo);
  const original = messageItem('raw_msg_native', 'hello');
  const store = createResponsesHttpStore(apiKeyId, undefined);
  const iterator = wrapWithStore(framesFrom([
    { type: 'response.output_item.added', output_index: 0, item: { ...original, content: [] } },
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: response([original]) },
  ]), store)[Symbol.asyncIterator]();

  const addedFrame = await iterator.next();
  assertEquals((addedFrame.value as ProtocolFrame<ResponsesStreamEvent>).type, 'event');
  assertEquals(controlled.calls.length, 0);

  // done is held until the row insert resolves; the client that has seen
  // `done` finds the row on its next turn.
  const doneFrame = iterator.next();
  assertEquals(await promiseStateAfterMicrotasks(doneFrame), 'pending');
  await waitForInsertCall(controlled);
  assertEquals(controlled.calls.length, 1);
  controlled.resolveInsert?.();
  assertEquals(((await doneFrame).value as ProtocolFrame<ResponsesStreamEvent>).type, 'event');
});

test('insert failure does not sink the stream', async () => {
  const repo = new InMemoryRepo();
  const controlled = new ControlledResponsesItemsRepo();
  repo.responsesItems = controlled;
  initRepo(repo);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const original = messageItem('raw_msg_native', 'hello');
    const store = createResponsesHttpStore(apiKeyId, undefined);
    const iterator = wrapWithStore(framesFrom([
      { type: 'response.output_item.added', output_index: 0, item: { ...original, content: [] } },
      { type: 'response.output_item.done', output_index: 0, item: original },
      { type: 'response.completed', response: response([original]) },
    ]), store)[Symbol.asyncIterator]();

    assertEquals(((await iterator.next()).value as ProtocolFrame<ResponsesStreamEvent>).type, 'event');

    const doneFrame = iterator.next();
    assertEquals(await promiseStateAfterMicrotasks(doneFrame), 'pending');
    await waitForInsertCall(controlled);
    controlled.rejectInsert?.(new Error('insert failed'));
    assertEquals(((await doneFrame).value as ProtocolFrame<ResponsesStreamEvent>).type, 'event');

    const completed = (await iterator.next()).value as ProtocolFrame<ResponsesStreamEvent>;
    assert(completed.type === 'event' && completed.event.type === 'response.completed');
    assert((await iterator.next()).done);
    assert(errorSpy.mock.calls.length > 0);
  } finally {
    errorSpy.mockRestore();
  }
});

test('does not insert rows for failed streams without observed items', async () => {
  const repo = new InMemoryRepo();
  const controlled = new ControlledResponsesItemsRepo();
  repo.responsesItems = controlled;
  initRepo(repo);

  const { events } = wrap(framesFrom([
    { type: 'response.failed', response: response([], 'failed') },
  ]));

  const collected = await collectEvents(events);
  assertEquals(collected.at(-1)?.type, 'response.failed');
  assertEquals(controlled.calls.length, 0);
});

test('store false creates metadata rows with null payload', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_msg_native', 'hello');

  const { events } = wrap(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: response([original]) },
  ]), { store: false });

  const collected = await collectEvents(events);
  const storedId = eventAt(collected, 'response.output_item.done').item.id!;
  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(row.payload, null);
  assertEquals(row.upstreamItemId, original.id);
});

test('terminal output items missing done frames are stored and rewritten', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_terminal_only', 'late');

  const { events } = wrap(framesFrom([
    { type: 'response.completed', response: response([original]) },
  ]));

  const collected = await collectEvents(events);
  const storedId = eventAt(collected, 'response.completed').response.output[0].id!;
  assert(isStoredResponsesItemId(storedId));
  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(row.payload, { item: original });
});

test('two distinct upstream items receive distinct stored ids', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const first = messageItem('raw_msg_1', 'first');
  const second = messageItem('raw_msg_2', 'second');

  const { events } = wrap(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: first },
    { type: 'response.output_item.done', output_index: 1, item: second },
    { type: 'response.completed', response: response([first, second]) },
  ]));

  const collected = await collectEvents(events);
  const done = collected.filter((event): event is Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }> => event.type === 'response.output_item.done');
  assert(done[0].item.id !== done[1].item.id);
  assert(isStoredResponsesItemId(done[0].item.id!));
  assert(isStoredResponsesItemId(done[1].item.id!));
  const rows = await repo.responsesItems.lookupMany(apiKeyId, [done[0].item.id!, done[1].item.id!]);
  assertEquals(rows.length, 2);
  assertEquals(rows[0].upstreamItemId, 'raw_msg_1');
  assertEquals(rows[1].upstreamItemId, 'raw_msg_2');
});

test('via-translation synthesized items do not claim upstream ownership', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('msg_0', 'translated');

  const store = createResponsesHttpStore(apiKeyId, undefined);
  const events = wrapWithStore(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: response([original]) },
  ]), store, { targetApi: 'messages' });

  const collected = await collectEvents(events);
  const storedId = eventAt(collected, 'response.output_item.done').item.id!;
  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(row.upstreamId, null);
  assertEquals(row.upstreamItemId, null);
});

test('gateway-synthesized items do not claim upstream ownership on a native stream', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const synthetic: Extract<ResponsesOutputItem, { type: 'web_search_call' }> = {
    type: 'web_search_call',
    id: 'ws_gw_synthetic00000000000',
    status: 'completed',
    action: { type: 'search', query: 'q', queries: ['q'] },
    results: [],
  };

  const { events } = wrap(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: synthetic },
    { type: 'response.completed', response: response([synthetic]) },
  ]), { syntheticItemIds: [synthetic.id] });

  const collected = await collectEvents(events);
  const storedId = eventAt(collected, 'response.output_item.done').item.id!;
  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(row.upstreamId, null);
  assertEquals(row.upstreamItemId, null);
  assertEquals(row.itemType, 'web_search_call');
});

test('private payload registered on the request is attached to the persisted row', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const synthetic: Extract<ResponsesOutputItem, { type: 'web_search_call' }> = {
    type: 'web_search_call',
    id: 'ws_gw_priv00000000000000000',
    status: 'completed',
    action: { type: 'search', query: 'q', queries: ['q'] },
    results: [{ type: 'text_result', url: 'u', title: 't', snippet: 'public-wire' }],
  };
  const privateBlob = { v: 1, functionCallItem: { type: 'function_call', call_id: 'call_orig_xyz', name: 'web_search', arguments: '{"search_query":[{"q":"q"}]}', status: 'completed' }, ir: { action: synthetic.action, results: [{ type: 'text_result', url: 'u', title: 't', snippet: 'server-only body' }] } };

  const { events } = wrap(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: synthetic },
    { type: 'response.completed', response: response([synthetic]) },
  ]), { syntheticItemIds: [synthetic.id], privatePayloads: [[synthetic.id, privateBlob]] });

  const collected = await collectEvents(events);
  const storedId = eventAt(collected, 'response.output_item.done').item.id!;
  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(row.payload?.private, privateBlob);
});

// --- snapshotMode tests ---

test('snapshotMode=none: no snapshot written after terminal event', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_msg_snap_none', 'hi');
  const store = createResponsesHttpStore(apiKeyId, undefined);

  const events = wrapWithStore(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: { ...response([original]), id: 'resp_snap_none' } },
  ]), store, { snapshotMode: 'none' });

  await collectEvents(events);
  const snapshot = await repo.responsesSnapshots.lookup(apiKeyId, 'resp_snap_none');
  assertEquals(snapshot, null);
});

test('snapshotMode=append: snapshot written after terminal event', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_msg_snap_append', 'hi');
  const store = createResponsesHttpStore(apiKeyId, undefined);

  const events = wrapWithStore(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: { ...response([original]), id: 'resp_upstream_ignored' } },
  ]), store, { snapshotMode: 'append', responseId: 'resp_snap_append' });

  await collectEvents(events);
  const snapshot = await repo.responsesSnapshots.lookup(apiKeyId, 'resp_snap_append');
  assert(snapshot !== null, 'expected snapshot to be written under floway-minted id');
  assertEquals(snapshot.id, 'resp_snap_append');
});

test('snapshotMode=replace: snapshot written after terminal event', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_msg_snap_replace', 'hi');
  const store = createResponsesHttpStore(apiKeyId, undefined);

  const events = wrapWithStore(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: { ...response([original]), id: 'resp_upstream_ignored' } },
  ]), store, { snapshotMode: 'replace', responseId: 'resp_snap_replace' });

  await collectEvents(events);
  const snapshot = await repo.responsesSnapshots.lookup(apiKeyId, 'resp_snap_replace');
  assert(snapshot !== null, 'expected snapshot to be written under floway-minted id');
  assertEquals(snapshot.id, 'resp_snap_replace');
});

test('snapshot commit error does not sink the stream', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_msg_snap_err', 'hi');
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const repoBacking = new RepoStatefulResponsesBacking(() => repo);
    const faultyBacking: StatefulResponsesBacking = {
      lookupItems: args => repoBacking.lookupItems(args),
      insertItems: items => repoBacking.insertItems(items),
      fillPayloads: items => repoBacking.fillPayloads(items),
      refreshItems: (aid, ids, at) => repoBacking.refreshItems(aid, ids, at),
      lookupSnapshot: async () => null,
      insertSnapshot: async () => { throw new Error('snapshot write failed'); },
      refreshSnapshot: async () => {},
    };

    const faultyStore = new LayeredStatefulResponsesStore({
      apiKeyId,
      reads: [repoBacking],
      itemWrites: [{ backing: repoBacking, durable: true }],
      snapshotWrites: [{ backing: faultyBacking, durable: false }],
      stageInputs: true,
    });

    const events = wrapWithStore(framesFrom([
      { type: 'response.output_item.done', output_index: 0, item: original },
      { type: 'response.completed', response: { ...response([original]), id: 'resp_snap_fail' } },
    ]), faultyStore, { snapshotMode: 'append' });

    const collected = await collectEvents(events);
    // Stream should complete despite snapshot failure
    assert(collected.at(-1)?.type === 'response.completed');
    assert(errorSpy.mock.calls.some(call => String(call[0]).includes('snapshot')));
  } finally {
    errorSpy.mockRestore();
  }
});

test('in-stream commit: row is visible immediately after done frame', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_msg_in_stream', 'hi');
  const store = createResponsesHttpStore(apiKeyId, undefined);

  const iterator = wrapWithStore(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: response([original]) },
  ]), store)[Symbol.asyncIterator]();

  const doneFrame = await iterator.next();
  assert(doneFrame.value?.type === 'event');
  const storedId = (doneFrame.value.event as Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }>).item.id!;

  // Row should be committed before the done frame was yielded
  const rows = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(rows.length, 1, 'row should be visible immediately after done frame');
});

test('end-of-stream items in terminal frame are stored and rewritten', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_terminal_eoi', 'eos');
  const store = createResponsesHttpStore(apiKeyId, undefined);

  const events = wrapWithStore(framesFrom([
    { type: 'response.completed', response: response([original]) },
  ]), store);

  const collected = await collectEvents(events);
  const storedId = eventAt(collected, 'response.completed').response.output[0].id!;
  assert(isStoredResponsesItemId(storedId));
  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(row.payload, { item: original });
});

// --- syntheticEventsFromResult / drainAsync ---

test('syntheticEventsFromResult emits the same frame sequence as emitToResponsesCompact', async () => {
  const item = messageItem('compact_msg_01', 'hello');
  const result: ResponsesResult = {
    id: 'resp_compact_test',
    object: 'response',
    model: 'gpt-test',
    status: 'completed',
    output: [item],
    output_text: 'hello',
    error: null,
    incomplete_details: null,
  };

  const frames: ProtocolFrame<ResponsesStreamEvent>[] = [];
  for await (const frame of syntheticEventsFromResult(result)) frames.push(frame);

  // responsesResultToEvents with genericOutputItems produces:
  //   response.created, response.in_progress,
  //   response.output_item.added, response.output_item.done (generic pair),
  //   response.completed
  // then a done sentinel frame.
  const eventTypes = frames.filter(f => f.type === 'event').map(f => (f as { event: ResponsesStreamEvent }).event.type);
  assertEquals(eventTypes, [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.output_item.done',
    'response.completed',
  ]);
  assertEquals(frames.at(-1)?.type, 'done');
});

test('drainAsync iterates to completion and returns void', async () => {
  let count = 0;
  const iter = async function* () {
    count += 1;
    yield 'a';
    count += 1;
    yield 'b';
    count += 1;
  };
  const result = await drainAsync(iter());
  assertEquals(result, undefined);
  assertEquals(count, 3);
});
