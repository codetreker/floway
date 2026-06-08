import { describe, test } from 'vitest';

import { enumerateProviderCandidates } from './candidates.ts';
import { setupAppTest } from '../../../test-helpers.ts';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { LlmTargetApi, UpstreamRecord } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

// Azure provider resolves its model catalog from config without HTTP calls,
// making it the right choice for tests that need a predictable in-memory catalog.
const azureUpstream = (id: string, sortOrder: number, modelIds: string[], endpoints: ModelEndpoints): UpstreamRecord => ({
  id,
  provider: 'azure',
  name: id,
  enabled: true,
  sortOrder,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  config: {
    endpoint: `https://${id}.openai.azure.com`,
    apiKey: 'az-key',
    models: modelIds.map(upstreamModelId => ({ upstreamModelId, endpoints })),
  },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
});

// pickTarget helpers mirroring the preference chains each source uses.
const pickMessages = (e: ModelEndpoints): LlmTargetApi | null =>
  e.messages ? 'messages' : null;

const pickMessagesOrResponses = (e: ModelEndpoints): LlmTargetApi | null =>
  e.messages ? 'messages' : e.responses ? 'responses' : null;

const pickResponses = (e: ModelEndpoints): LlmTargetApi | null =>
  e.responses ? 'responses' : null;

const pickAny = (e: ModelEndpoints): LlmTargetApi | null =>
  e.messages ? 'messages' : e.responses ? 'responses' : e.chatCompletions ? 'chat-completions' : null;

describe('enumerateProviderCandidates', () => {
  test('single provider with a matching binding yields one candidate', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_a', 10, ['test-model'], { messages: {} }));

    const { candidates, sawModel } = await enumerateProviderCandidates({
      apiKeyUpstreamIds: null,
      model: 'test-model',
      pickTarget: pickMessages,
    });

    assertEquals(candidates.length, 1);
    assertEquals(candidates[0].provider.upstream, 'up_a');
    assertEquals(candidates[0].binding.upstreamModel.id, 'test-model');
    assertEquals(candidates[0].targetApi, 'messages');
    assertEquals(sawModel, true);
  });

  test('provider with binding but pickTarget returns null yields no candidate but sets sawModel', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    // Provider only has chatCompletions; pickMessages requires messages.
    await repo.upstreams.save(azureUpstream('up_chat', 10, ['test-model'], { chatCompletions: {} }));

    const { candidates, sawModel } = await enumerateProviderCandidates({
      apiKeyUpstreamIds: null,
      model: 'test-model',
      pickTarget: pickMessages,
    });

    assertEquals(candidates.length, 0);
    // The model exists on a provider — sawModel distinguishes this from a
    // model that no provider knows about, so the serve renders 400
    // model-unsupported instead of 404 model-missing.
    assertEquals(sawModel, true);
  });

  test('provider without a binding for the requested model yields no candidate and sawModel=false', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_a', 10, ['other-model'], { messages: {} }));

    const { candidates, sawModel } = await enumerateProviderCandidates({
      apiKeyUpstreamIds: null,
      model: 'test-model',
      pickTarget: pickMessages,
    });

    assertEquals(candidates.length, 0);
    assertEquals(sawModel, false);
  });

  test('multiple providers: only those with the model produce candidates in sort_order', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_first', 10, ['test-model'], { messages: {} }));
    // up_second does not carry test-model.
    await repo.upstreams.save(azureUpstream('up_second', 20, ['other-model'], { messages: {} }));
    await repo.upstreams.save(azureUpstream('up_third', 30, ['test-model'], { messages: {} }));

    const { candidates } = await enumerateProviderCandidates({
      apiKeyUpstreamIds: null,
      model: 'test-model',
      pickTarget: pickMessages,
    });

    assertEquals(candidates.length, 2);
    assertEquals(candidates[0].provider.upstream, 'up_first');
    assertEquals(candidates[1].provider.upstream, 'up_third');
  });

  test('apiKeyUpstreamIds filtering: only matching providers surface in given order', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_a', 10, ['test-model'], { messages: {} }));
    await repo.upstreams.save(azureUpstream('up_b', 20, ['test-model'], { messages: {} }));
    await repo.upstreams.save(azureUpstream('up_c', 30, ['test-model'], { messages: {} }));

    const { candidates } = await enumerateProviderCandidates({
      apiKeyUpstreamIds: ['up_c', 'up_a'],
      model: 'test-model',
      pickTarget: pickMessages,
    });

    assertEquals(candidates.length, 2);
    assertEquals(candidates[0].provider.upstream, 'up_c');
    assertEquals(candidates[1].provider.upstream, 'up_a');
  });

  test('apiKeyUpstreamIds=null returns all enabled providers', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(azureUpstream('up_enabled', 10, ['test-model'], { messages: {} }));
    await repo.upstreams.save({
      ...azureUpstream('up_disabled', 20, ['test-model'], { messages: {} }),
      enabled: false,
    });

    const { candidates } = await enumerateProviderCandidates({
      apiKeyUpstreamIds: null,
      model: 'test-model',
      pickTarget: pickMessages,
    });

    assertEquals(candidates.length, 1);
    assertEquals(candidates[0].provider.upstream, 'up_enabled');
  });

  test('pickTarget preference: multi-endpoint binding picks according to pickTarget logic', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    // Provider supports both messages and responses.
    await repo.upstreams.save(azureUpstream('up_multi', 10, ['test-model'], { messages: {}, responses: {} }));

    // pickMessagesOrResponses prefers messages over responses.
    const { candidates: msgCandidates } = await enumerateProviderCandidates({
      apiKeyUpstreamIds: null,
      model: 'test-model',
      pickTarget: pickMessagesOrResponses,
    });
    assertEquals(msgCandidates.length, 1);
    assertEquals(msgCandidates[0].targetApi, 'messages');

    // pickResponses only accepts responses.
    const { candidates: resCandidates } = await enumerateProviderCandidates({
      apiKeyUpstreamIds: null,
      model: 'test-model',
      pickTarget: pickResponses,
    });
    assertEquals(resCandidates.length, 1);
    assertEquals(resCandidates[0].targetApi, 'responses');
  });

  test('pickTarget returning null filters out an otherwise-matching provider', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    // Provider only has chatCompletions; pickAny picks it, but pickMessages rejects it.
    await repo.upstreams.save(azureUpstream('up_chat', 10, ['test-model'], { chatCompletions: {} }));

    const { candidates: anyCandidates } = await enumerateProviderCandidates({
      apiKeyUpstreamIds: null,
      model: 'test-model',
      pickTarget: pickAny,
    });
    assertEquals(anyCandidates.length, 1);
    assertEquals(anyCandidates[0].targetApi, 'chat-completions');

    const { candidates: msgCandidates, sawModel } = await enumerateProviderCandidates({
      apiKeyUpstreamIds: null,
      model: 'test-model',
      pickTarget: pickMessages,
    });
    assertEquals(msgCandidates.length, 0);
    // pickTarget filtered out, but the model exists — sawModel stays true.
    assertEquals(sawModel, true);
  });
});
