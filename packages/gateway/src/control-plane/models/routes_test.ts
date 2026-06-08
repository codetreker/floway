import { test } from 'vitest';

import { buildCustomUpstreamRecord, copilotModels, requestApp, setupAppTest } from '../../test-helpers.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const azureUpstream = (): UpstreamRecord => ({
  id: 'up_azure_models',
  provider: 'azure',
  name: 'Azure Models',
  enabled: true,
  sortOrder: 200,
  createdAt: '2026-05-21T00:00:00.000Z',
  updatedAt: '2026-05-21T00:00:00.000Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  config: {
    endpoint: 'https://example.openai.azure.com',
    apiKey: 'az-key',
    models: [
      {
        upstreamModelId: 'azure-model',
        publicModelId: 'azure-public',
        endpoints: { responses: {} },
      },
    ],
  },
  state: null,
});

test('/api/models exposes each binding as { kind, id } so multi-provider models are unambiguous', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_custom_models', sortOrder: 100 }));
  await repo.upstreams.save(azureUpstream());

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600 });
      }
      if (url.hostname === 'api.githubcopilot.com' && url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-sonnet-4', display_name: 'Claude Sonnet 4', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'custom-model', supported_endpoints: ['/chat/completions'] }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/api/models', { headers: { 'x-api-key': apiKey.key } });
      assertEquals(response.status, 200);
      const body = (await response.json()) as { data: Array<Record<string, unknown>> };

      assertEquals(body.data.find(model => model.id === 'claude-sonnet-4')?.upstreams, [{ kind: 'copilot', id: 'up_copilot', name: 'GitHub Copilot (tester)' }]);
      assertEquals(body.data.find(model => model.id === 'custom-model')?.upstreams, [{ kind: 'custom', id: 'up_custom_models', name: 'Custom Provider' }]);
      assertEquals(body.data.find(model => model.id === 'azure-public')?.upstreams, [{ kind: 'azure', id: 'up_azure_models', name: 'Azure Models' }]);
      for (const model of body.data) {
        // Legacy split fields must not reappear.
        assertEquals(Object.hasOwn(model, 'provider'), false);
        assertEquals(Object.hasOwn(model, 'upstream_ids'), false);
        assertEquals(Object.hasOwn(model, 'upstream_kind'), false);
      }
    },
  );
});
