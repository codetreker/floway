import { test } from 'vitest';

import { compareModelIds, getInternalModels, listModelProviders, resolveModelForProvider, resolveModelForRequest } from './registry.ts';
import { buildCopilotUpstreamRecord, buildCustomUpstreamRecord, copilotModels, setupAppTest } from '../../test-helpers.ts';
import { createCopilotProvider } from '@floway-dev/provider-copilot';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const sortedIds = (ids: readonly string[]): string[] => [...ids].sort(compareModelIds);

test('compareModelIds pushes ids containing "/" to the tail', () => {
  assertEquals(sortedIds(['accounts/msft/x', 'gpt-4o', 'accounts/msft/y', 'claude-opus-4-7']), [
    'claude-opus-4-7',
    'gpt-4o',
    // Within the slashed group, the remaining keys still apply: same alpha
    // prefix "accounts", empty isolated-digit arrays, then descending lex.
    'accounts/msft/y',
    'accounts/msft/x',
  ]);
});

test('compareModelIds groups by leading [a-zA-Z]+ prefix, case-insensitive ascending', () => {
  // gpt and GPT collapse on key 1; their tied [4] digit array falls to
  // descending lex (lowercased), so 'gpt-4o-mini' beats 'gpt-4o'.
  assertEquals(sortedIds(['gpt-4o', 'claude-haiku-4-5', 'deepseek-v4-pro', 'GPT-4o-mini']), [
    'claude-haiku-4-5',
    'deepseek-v4-pro',
    'GPT-4o-mini',
    'gpt-4o',
  ]);
});

test('compareModelIds orders isolated single digits descending element by element', () => {
  // Digit arrays: claude-opus-4-7 [4,7], claude-sonnet-4-6 [4,6],
  // claude-opus-4-5 / claude-haiku-4-5 [4,5]. Within the [4,5] tie, lex
  // descending picks 'claude-opus-4-5' over 'claude-haiku-4-5'.
  assertEquals(sortedIds(['claude-opus-4-7', 'claude-opus-4-5', 'claude-haiku-4-5', 'claude-sonnet-4-6']), [
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-opus-4-5',
    'claude-haiku-4-5',
  ]);
});

test('compareModelIds puts longer digit arrays before shorter ones (descending)', () => {
  // [5,5] beats every [4]; within the tied-[4] group, descending lex on the
  // full id puts 'gpt-4o' first, then 'gpt-4-turbo', then 'gpt-4' last.
  assertEquals(sortedIds(['gpt-5.5', 'gpt-4', 'gpt-4o', 'gpt-4-turbo']), [
    'gpt-5.5',
    'gpt-4o',
    'gpt-4-turbo',
    'gpt-4',
  ]);
});

test('compareModelIds ignores multi-digit runs such as dates', () => {
  // Both have digit array [4, 7]; descending lex tie-break puts the longer
  // dated id first.
  assertEquals(sortedIds(['claude-opus-4-7-20300101', 'claude-opus-4-7']), [
    'claude-opus-4-7-20300101',
    'claude-opus-4-7',
  ]);
});

test('compareModelIds sorts ids without a leading alpha prefix first', () => {
  assertEquals(sortedIds(['gpt-4o', 'o1-mini', '128k-context-model']), [
    '128k-context-model',
    'gpt-4o',
    'o1-mini',
  ]);
});

test('compareModelIds keeps case-only differences adjacent via lowercase tie-break', () => {
  // All lowercase to 'gpt-4o' so case-folded lex ties; raw descending then
  // picks lowercase letters before uppercase (g > G in ASCII).
  assertEquals(sortedIds(['GPT-4o', 'gpt-4o', 'gpt-4O']), [
    'gpt-4o',
    'gpt-4O',
    'GPT-4o',
  ]);
});

test('createCopilotProvider exposes provider-owned requested model aliases', async () => {
  const { copilotUpstream } = await setupAppTest();
  const instance = await createCopilotProvider(copilotUpstream);
  const resolveAlias = instance.resolveRequestedModelId;

  assertEquals(resolveAlias?.('claude-opus-4-7-20300101'), 'claude-opus-4-7');
  assertEquals(resolveAlias?.('claude-opus-4-7-xhigh-20300101'), 'claude-opus-4-7');
  assertEquals(resolveAlias?.('claude-opus-4.7'), 'claude-opus-4-7');
  assertEquals(resolveAlias?.('codex-auto-review'), undefined);
});

test('listModelProviders creates enabled provider instances with upstream row ids', async () => {
  const { githubAccount, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_custom', sortOrder: 1 }));
  await repo.upstreams.save({
    id: 'up_azure',
    provider: 'azure',
    name: 'Azure Resource',
    enabled: true,
    sortOrder: 2,
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    config: {
      endpoint: 'https://example.openai.azure.com',
      apiKey: 'az-key',
      models: [
        {
          upstreamModelId: 'gpt-prod',
          endpoints: { chatCompletions: {} },
        },
      ],
    },
    flagOverrides: {},
    disabledPublicModelIds: [],
    state: null,
  });
  await repo.upstreams.save(buildCopilotUpstreamRecord(githubAccount, { id: 'up_copilot', name: 'Copilot Row', sortOrder: 3 }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_disabled', enabled: false, sortOrder: 0 }));

  const providers = await listModelProviders();

  assertEquals(
    providers.map(provider => provider.upstream),
    ['up_custom', 'up_azure', 'up_copilot'],
  );
  assertEquals(providers.some(provider => provider.upstream.includes(':')), false);
});

test('getInternalModels returns the catalog projection without execution bindings', async () => {
  const { repo } = await setupAppTest();

  await repo.upstreams.save(buildCustomUpstreamRecord());
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_disabled', enabled: false, sortOrder: 50 }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.hostname === 'api.githubcopilot.com' && url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            {
              id: 'shared-model',
              display_name: 'Shared Model',
              supported_endpoints: ['/v1/messages'],
            },
          ]),
        );
      }
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [
            {
              id: 'shared-model',
              supported_endpoints: ['/chat/completions'],
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const catalog = await getInternalModels();
      const model = catalog.find(candidate => candidate.id === 'shared-model');

      assertEquals(model?.display_name, 'Shared Model');
      assertEquals(Object.hasOwn(model!, 'endpoints'), false);
      assertEquals(model?.kind, 'chat');
      assertEquals(Object.hasOwn(model!, 'providers'), false);
      assertEquals(Object.hasOwn(model!, 'providerData'), false);

      const resolved = await resolveModelForRequest('shared-model');
      assertEquals(resolved.model?.endpoints, { messages: {}, chatCompletions: {} });
      assertEquals(
        resolved.model?.providers.map(({ upstream }) => upstream),
        ['up_copilot', 'up_custom'],
      );
    },
  );
});

test('resolveModelForRequest applies provider-owned aliases only to that provider', async () => {
  const { repo } = await setupAppTest();

  await repo.upstreams.save(
    buildCustomUpstreamRecord({
      config: {
        baseUrl: 'https://custom.example.com',
        bearerToken: 'sk-custom',
        endpoints: { messages: {} },
      },
    }),
  );

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }
      if (url.hostname === 'api.githubcopilot.com' && url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-opus-4.7', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'claude-opus-4-7' }],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resolved = await resolveModelForRequest('claude-opus-4-7-20300101');

      assertEquals(resolved.id, 'claude-opus-4-7');
      assertEquals(resolved.model?.endpoints, { messages: {} });
      assertEquals(
        resolved.model?.providers.map(({ upstream }) => upstream),
        ['up_copilot'],
      );
    },
  );
});

test('resolveModelForProvider only loads the selected provider catalog', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_first',
    name: 'First',
    sortOrder: 0,
    config: { baseUrl: 'https://first.example.com', bearerToken: 'sk-first', endpoints: { responses: {} } },
  }));
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_second',
    name: 'Second',
    sortOrder: 100,
    config: { baseUrl: 'https://second.example.com', bearerToken: 'sk-second', endpoints: { responses: {} } },
  }));

  const providers = await listModelProviders();
  let secondModelsFetches = 0;

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'first.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ data: [{ id: 'target-model' }] });
      }
      if (url.hostname === 'second.example.com' && url.pathname === '/v1/models') {
        secondModelsFetches++;
        return jsonResponse({ data: [{ id: 'target-model' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resolved = await resolveModelForProvider(providers[0], 'target-model');

      assertEquals(resolved?.model.id, 'target-model');
      assertEquals(resolved?.binding.upstream, 'up_first');
    },
  );

  assertEquals(secondModelsFetches, 0);
});

test('listModelProviders without a filter returns global sort_order', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_a', name: 'A', sortOrder: 10 }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_b', name: 'B', sortOrder: 20 }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_c', name: 'C', sortOrder: 30 }));

  const providers = await listModelProviders();
  assertEquals(providers.map(p => p.upstream), ['up_a', 'up_b', 'up_c']);
});

test('listModelProviders honors a per-key whitelist with custom order', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_a', name: 'A', sortOrder: 10 }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_b', name: 'B', sortOrder: 20 }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_c', name: 'C', sortOrder: 30 }));

  // Subset, reverse order, with the planner's fallback head explicitly chosen.
  const providers = await listModelProviders(['up_c', 'up_a']);
  assertEquals(providers.map(p => p.upstream), ['up_c', 'up_a']);
});

test('disabledPublicModelIds hides models from the catalog and routing, per upstream', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const azureUpstream = (over: { id: string; sortOrder: number; models: { upstreamModelId: string; publicModelId?: string }[]; disabledPublicModelIds: string[] }) => ({
    id: over.id,
    provider: 'azure' as const,
    name: over.id,
    enabled: true,
    sortOrder: over.sortOrder,
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    config: {
      endpoint: 'https://example.openai.azure.com',
      apiKey: 'az-key',
      models: over.models.map(m => ({ ...m, endpoints: { chatCompletions: {} } })),
    },
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: over.disabledPublicModelIds,
  });

  // up_a disables a solo model and a shared one (by public id, including a
  // publicModelId override); up_b still serves the shared id, enabled.
  await repo.upstreams.save(azureUpstream({
    id: 'up_a',
    sortOrder: 1,
    models: [
      { upstreamModelId: 'gpt-keep' },
      { upstreamModelId: 'gpt-solo' },
      { upstreamModelId: 'gpt-shared' },
      { upstreamModelId: 'dep-x', publicModelId: 'gpt-override' },
    ],
    disabledPublicModelIds: ['gpt-solo', 'gpt-shared', 'gpt-override'],
  }));
  await repo.upstreams.save(azureUpstream({
    id: 'up_b',
    sortOrder: 2,
    models: [{ upstreamModelId: 'gpt-shared' }],
    disabledPublicModelIds: [],
  }));

  const catalog = await getInternalModels();
  assertEquals([...catalog.map(m => m.id)].sort(), ['gpt-keep', 'gpt-shared']);

  // The solo and override ids resolve to nothing (hidden + unroutable).
  assertEquals((await resolveModelForRequest('gpt-solo')).model, undefined);
  assertEquals((await resolveModelForRequest('gpt-override')).model, undefined);

  // The shared id survives because up_b allows it; only up_b binds it.
  const shared = await resolveModelForRequest('gpt-shared');
  assertEquals(shared.model?.providers.map(({ upstream }) => upstream), ['up_b']);

  // The untouched model still routes from up_a.
  const keep = await resolveModelForRequest('gpt-keep');
  assertEquals(keep.model?.providers.map(({ upstream }) => upstream), ['up_a']);
});

test('resolveModelForProvider rejects a model id disabled on that upstream (filter parity with the catalog)', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save({
    id: 'up_x',
    provider: 'azure',
    name: 'X',
    enabled: true,
    sortOrder: 1,
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    config: {
      endpoint: 'https://example.openai.azure.com',
      apiKey: 'az-key',
      models: [
        { upstreamModelId: 'enabled-model', endpoints: { chatCompletions: {} } },
        { upstreamModelId: 'disabled-model', endpoints: { chatCompletions: {} } },
      ],
    },
    flagOverrides: {},
    disabledPublicModelIds: ['disabled-model'],
    state: null,
  });

  const [provider] = await listModelProviders();
  assertEquals(await resolveModelForProvider(provider, 'enabled-model').then(r => r?.id), 'enabled-model');
  assertEquals(await resolveModelForProvider(provider, 'disabled-model').then(r => r?.id), undefined);
});

test('listModelProviders drops stale ids (deleted or disabled upstreams) from a whitelist', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_a', name: 'A', sortOrder: 10 }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_b', name: 'B', sortOrder: 20, enabled: false }));

  // up_ghost was never saved; up_b is disabled. Both vanish silently.
  const providers = await listModelProviders(['up_ghost', 'up_b', 'up_a']);
  assertEquals(providers.map(p => p.upstream), ['up_a']);
});
