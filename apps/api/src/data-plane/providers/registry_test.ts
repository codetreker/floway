import { test } from 'vitest';

import { compareModelIds, getInternalModels, listModelProviders, resolveModelForRequest } from './registry.ts';
import { assertEquals } from '../../test-assert.ts';
import { buildCopilotUpstreamRecord, buildCustomUpstreamRecord, copilotModels, jsonResponse, setupAppTest, withMockedFetch } from '../../test-helpers.ts';
import { createCopilotProvider } from './copilot/provider.ts';

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
      deployments: [
        {
          deployment: 'gpt-prod',
          supportedEndpoints: ['/chat/completions'],
        },
      ],
    },
    flagOverrides: {},
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
      assertEquals(Object.hasOwn(model!, 'upstreamEndpoints'), false);
      assertEquals(model?.supports_generation, true);
      assertEquals(Object.hasOwn(model!, 'providers'), false);
      assertEquals(Object.hasOwn(model!, 'providerData'), false);

      const resolved = await resolveModelForRequest('shared-model');
      assertEquals(resolved.model?.upstreamEndpoints, ['messages', 'messages_count_tokens', 'chat_completions']);
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
        supportedEndpoints: ['/v1/messages'],
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
      assertEquals(resolved.model?.upstreamEndpoints, ['messages', 'messages_count_tokens']);
      assertEquals(
        resolved.model?.providers.map(({ upstream }) => upstream),
        ['up_copilot'],
      );
    },
  );
});
