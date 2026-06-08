import { Hono } from 'hono';
import { test, vi } from 'vitest';

import { createStoredResponsesItemId, isStoredResponseId } from './items/format.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import type { StoredResponsesItem } from '../../../repo/types.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubUpstreamModel } from '@floway-dev/test-utils';

// Mock the candidates seam so each test hands the http entry exactly the
// provider candidates it wants. Mirrors the pattern from serve_test.ts.
const candidatesQueue: { readonly candidates: readonly ProviderCandidate[]; readonly sawModel: boolean }[] = [];
const seenModels: string[] = [];
vi.mock('../shared/candidates.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../shared/candidates.ts')>();
  return {
    ...original,
    enumerateProviderCandidates: vi.fn(async (args: { model: string }) => {
      seenModels.push(args.model);
      const next = candidatesQueue.shift();
      if (next === undefined) throw new Error('http_test: no candidates enqueued');
      return next;
    }),
  };
});

const { responsesHttp } = await import('./http.ts');

const API_KEY_ID = 'key_http_test';

const queueCandidates = (candidates: readonly ProviderCandidate[], sawModel = candidates.length > 0): void => {
  candidatesQueue.push({ candidates, sawModel });
};

const installRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return repo;
};

const makeApp = (): Hono<{ Variables: { apiKeyId: string; apiKeyUpstreamIds: readonly string[] } }> => {
  const app = new Hono<{ Variables: { apiKeyId: string; apiKeyUpstreamIds: readonly string[] } }>();
  // Stamp the authenticated key onto every request so the http entry sees the
  // same value the real auth middleware would set.
  app.use('*', async (c, next) => {
    c.set('apiKeyId', API_KEY_ID);
    await next();
  });
  app.post('/v1/responses', responsesHttp.generate);
  app.post('/v1/responses/compact', responsesHttp.compact);
  return app;
};

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

const makeCandidate = (overrides: {
  upstream?: string;
  targetApi?: ProviderCandidate['targetApi'];
  callResponses?: (model: unknown, body: unknown, signal?: AbortSignal, headers?: Record<string, string>) => Promise<ProviderStreamResult<ResponsesStreamEvent>>;
  callResponsesCompact?: (...args: unknown[]) => Promise<unknown>;
} = {}): ProviderCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const targetApi = overrides.targetApi ?? 'responses';
  const upstreamModel = stubUpstreamModel();
  const provider = stubProvider({
    callResponses: overrides.callResponses,
    ...(overrides.callResponsesCompact !== undefined ? { callResponsesCompact: overrides.callResponsesCompact as never } : {}),
  });
  return {
    provider: {
      upstream,
      providerKind: 'custom',
      name: upstream,
      disabledPublicModelIds: [],
      provider,
      supportsResponsesItemReference: true,
    },
    binding: {
      upstream,
      upstreamName: upstream,
      providerKind: 'custom',
      provider,
      upstreamModel,
      enabledFlags: upstreamModel.enabledFlags,
      supportsResponsesItemReference: true,
    },
    targetApi,
  };
};

const completedEvent = (id = 'resp_test'): ResponsesStreamEvent => ({
  type: 'response.completed',
  sequence_number: 0,
  response: makeResponsesResult(id),
});

test('POST /v1/responses streams a successful SSE body', async () => {
  installRepo();
  const callResponses = vi.fn(async (): Promise<ProviderStreamResult<ResponsesStreamEvent>> => ({
    ok: true,
    events: makeProviderEvents([completedEvent()]),
    modelKey: 'test-model-key',
  }));
  queueCandidates([makeCandidate({ callResponses })]);

  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test-model', input: 'hello', stream: true }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'text/event-stream');
  const body = await response.text();
  assert(body.includes('event: response.completed'));
  // Wrap layer mints its own response id; upstream's "resp_test" is discarded.
  const completedMatch = body.match(/"id":"(resp_[A-Za-z0-9_-]+)"/);
  assert(completedMatch !== null, 'expected a floway-minted resp_ id in the SSE body');
  assert(isStoredResponseId(completedMatch[1]));
  assertEquals(callResponses.mock.calls.length, 1);
});

test('POST /v1/responses returns a single JSON body when stream is omitted', async () => {
  installRepo();
  const callResponses = vi.fn(async (): Promise<ProviderStreamResult<ResponsesStreamEvent>> => ({
    ok: true,
    events: makeProviderEvents([completedEvent('resp_nonstream')]),
    modelKey: 'test-model-key',
  }));
  queueCandidates([makeCandidate({ callResponses })]);

  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test-model', input: 'hello' }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as ResponsesResult;
  assert(isStoredResponseId(body.id), `expected floway-minted resp_ id, got ${body.id}`);
  assertEquals(body.status, 'completed');
});

test('POST /v1/responses/compact returns a non-streaming compaction envelope', async () => {
  installRepo();
  const compactionItem = { type: 'compaction' as const, id: 'cmp_1', encrypted_content: 'ENC' };
  const compactionResult: ResponsesResult = {
    ...makeResponsesResult(),
    object: 'response.compaction',
    output: [compactionItem] as unknown as ResponsesResult['output'],
  };
  const callResponsesCompact = vi.fn(async () => ({
    ok: true as const,
    result: compactionResult,
    modelKey: 'test-model-key',
  }));
  queueCandidates([makeCandidate({ callResponsesCompact })]);

  const response = await makeApp().request('/v1/responses/compact', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test-model',
      input: [{ type: 'message', role: 'user', content: 'kept' }],
    }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as { object: string; id: string };
  assertEquals(body.object, 'response.compaction');
  assert(isStoredResponseId(body.id), `expected floway-minted resp_ id, got ${body.id}`);
});

test('POST /v1/responses with an unresolvable previous_response_id renders the verbatim 400 envelope', async () => {
  installRepo();

  // No candidates need to be queued — the entry rejects before routing runs.
  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test-model',
      previous_response_id: 'resp_missing',
      input: [{ type: 'message', role: 'user', content: 'follow up' }],
    }),
  });

  assertEquals(response.status, 400);
  const body = await response.json() as { error: { message: string; type: string; param: string; code: string } };
  assertEquals(body.error.message, "Previous response with id 'resp_missing' not found.");
  assertEquals(body.error.type, 'invalid_request_error');
  assertEquals(body.error.param, 'previous_response_id');
  assertEquals(body.error.code, 'previous_response_not_found');
});

test('POST /v1/responses renders a routing-unavailable 400 when a forcing item names an absent upstream', async () => {
  const repo = installRepo();
  // A stored item pinned to `up_forcing` makes the input force-route to that
  // upstream; queueing a candidate for a different upstream produces the
  // routing-unavailable failure that the http entry must surface verbatim.
  const id = createStoredResponsesItemId('compaction');
  const row: StoredResponsesItem = {
    id,
    apiKeyId: API_KEY_ID,
    upstreamId: 'up_forcing',
    upstreamItemId: 'raw_cmp',
    itemType: 'compaction',
    origin: 'upstream',
    contentHash: null,
    encryptedContentHash: null,
    payload: null,
    createdAt: 1_000,
    refreshedAt: 1_000,
  };
  await repo.responsesItems.insertMany([row]);
  queueCandidates([makeCandidate({ upstream: 'up_b' })]);

  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test-model',
      input: [{ type: 'item_reference', id }],
    }),
  });

  assertEquals(response.status, 400);
  const body = await response.json() as { error: { code: string } };
  assertEquals(body.error.code, 'responses_item_routing_unavailable');
});

test('POST /v1/responses rewrites the codex-auto-review alias before routing', async () => {
  installRepo();
  seenModels.length = 0;
  const observedBodies: { reasoning?: { effort?: string } }[] = [];
  const callResponses = vi.fn(async (_model: unknown, body: unknown): Promise<ProviderStreamResult<ResponsesStreamEvent>> => {
    observedBodies.push(body as { reasoning?: { effort?: string } });
    return {
      ok: true,
      events: makeProviderEvents([completedEvent()]),
      modelKey: 'test-model-key',
    };
  });
  queueCandidates([makeCandidate({ callResponses })]);

  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'codex-auto-review', input: 'hello' }),
  });

  assertEquals(response.status, 200);
  assertEquals(seenModels, ['gpt-5.4']);
  const observed = observedBodies[0];
  if (observed === undefined) throw new Error('expected callResponses to receive a body');
  assertEquals(observed.reasoning?.effort, 'low');
});

test('POST /v1/responses/compact rewrites the codex-auto-review alias to gpt-5.4 with no reasoning field', async () => {
  installRepo();
  seenModels.length = 0;
  const observedBodies: { reasoning?: unknown }[] = [];
  const compactionItem = { type: 'compaction' as const, id: 'cmp_1', encrypted_content: 'ENC' };
  const compactionResult: ResponsesResult = {
    ...makeResponsesResult(),
    object: 'response.compaction',
    output: [compactionItem] as unknown as ResponsesResult['output'],
  };
  const callResponsesCompact = vi.fn(async (_model: unknown, body: unknown) => {
    observedBodies.push(body as { reasoning?: unknown });
    return { ok: true as const, result: compactionResult, modelKey: 'test-model-key' };
  });
  queueCandidates([makeCandidate({ callResponsesCompact })]);

  const response = await makeApp().request('/v1/responses/compact', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'codex-auto-review',
      input: [{ type: 'message', role: 'user', content: 'kept' }],
    }),
  });

  assertEquals(response.status, 200);
  assertEquals(seenModels, ['gpt-5.4']);
  const observed = observedBodies[0];
  if (observed === undefined) throw new Error('expected callResponsesCompact to receive a body');
  assertEquals(observed.reasoning, undefined);
});
