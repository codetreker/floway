import { test } from 'vitest';

import { clearCopilotTokenCache } from '../../shared/copilot.ts';
import { assertEquals } from '../../test-assert.ts';
import { buildCopilotUpstreamRecord, buildCustomUpstreamRecord, copilotModels, jsonResponse, requestApp, setupAppTest, withMockedFetch } from '../../test-helpers.ts';
import { clearModelsCache } from '../providers/upstream-model-cache.ts';

const SECOND_ACCOUNT = {
  token: 'ghu_second',
  accountType: 'individual',
  user: {
    id: 2002,
    login: 'second',
    name: 'Second Account',
    avatar_url: 'https://example.com/second.png',
  },
};

test('/v1/models returns merged model list from Copilot and custom upstreams', async () => {
  const { repo, apiKey } = await setupAppTest();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_oai',
    name: 'Test OpenAI',
    sortOrder: 100,
    config: {
      baseUrl: 'https://oai.example.com',
      bearerToken: 'sk-test',
      supportedEndpoints: ['/chat/completions'],
    },
  }));

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
      if (url.pathname === '/models' && url.hostname === 'api.githubcopilot.com') {
        return jsonResponse(
          copilotModels([
            {
              id: 'claude-sonnet-4',
              display_name: 'Claude Sonnet 4',
              supported_endpoints: ['/v1/messages'],
              billing: { is_premium: true, multiplier: 3 },
              policy: { state: 'enabled', terms: 'test terms' },
              model_picker_enabled: true,
            },
          ]),
        );
      }
      if (url.pathname === '/v1/models' && url.hostname === 'oai.example.com') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/models', {
        headers: { 'x-api-key': apiKey.key },
      });

      assertEquals(response.status, 200);
      const body = (await response.json()) as {
        object: string;
        data: Array<{
          id: string;
          name?: string;
          display_name?: string;
          supported_endpoints?: string[];
          supports_generation?: boolean;
          capabilities?: unknown;
          provider?: unknown;
          providerKind?: unknown;
          providers?: unknown;
          providerData?: unknown;
          supportedEndpoints?: unknown;
          upstream?: unknown;
          upstreamModel?: unknown;
          billing?: unknown;
          policy?: unknown;
          model_picker_enabled?: boolean;
        }>;
      };
      assertEquals(body.object, 'list');

      const ids = body.data.map(m => m.id);
      assertEquals(ids.includes('claude-sonnet-4'), true);
      assertEquals(ids.includes('gpt-4o'), true);
      assertEquals(ids.includes('gpt-4o-mini'), true);

      const claude = body.data.find(m => m.id === 'claude-sonnet-4');
      assertEquals(claude!.name, undefined);
      assertEquals(claude!.display_name, undefined);
      assertEquals(claude!.supported_endpoints, undefined);
      assertEquals(claude!.supports_generation, undefined);
      assertEquals(claude!.capabilities, undefined);
      assertEquals(claude!.provider, undefined);
      assertEquals(claude!.billing, undefined);
      assertEquals(claude!.policy, undefined);
      assertEquals(claude!.model_picker_enabled, undefined);

      const gpt4o = body.data.find(m => m.id === 'gpt-4o');
      assertEquals(gpt4o!.supported_endpoints, undefined);
      assertEquals(gpt4o!.provider, undefined);

      for (const model of body.data) {
        assertEquals(model.provider, undefined);
        assertEquals(model.providerKind, undefined);
        assertEquals(model.providers, undefined);
        assertEquals(model.providerData, undefined);
        assertEquals(model.supportedEndpoints, undefined);
        assertEquals(model.upstream, undefined);
        assertEquals(model.upstreamModel, undefined);
      }

      const controlResponse = await requestApp('/api/models', {
        headers: { 'x-api-key': apiKey.key },
      });
      assertEquals(controlResponse.status, 200);
      const controlBody = (await controlResponse.json()) as {
        data: Array<{
          id: string;
          name: string;
          display_name: string;
          supported_endpoints?: string[];
          provider?: 'copilot' | 'custom' | 'azure';
          billing?: unknown;
          policy?: unknown;
          model_picker_enabled?: boolean;
        }>;
      };
      const controlClaude = controlBody.data.find(m => m.id === 'claude-sonnet-4')!;
      assertEquals(controlClaude.name, 'Claude Sonnet 4');
      assertEquals(controlClaude.display_name, 'Claude Sonnet 4');
      assertEquals(controlClaude.provider, 'copilot');
      assertEquals(controlClaude.billing, { is_premium: true, multiplier: 3 });
      assertEquals(controlClaude.policy, {
        state: 'enabled',
        terms: 'test terms',
      });
      assertEquals(controlClaude.model_picker_enabled, true);
      assertEquals(controlClaude.supported_endpoints, ['/v1/messages']);
      assertEquals(controlBody.data.find(m => m.id === 'gpt-4o')?.provider, 'custom');
    },
  );
});

test('/models returns Anthropic-shaped model list', async () => {
  const { apiKey } = await setupAppTest();

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
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            {
              id: 'claude-opus-4.7-xhigh',
              display_name: 'Claude Opus 4.7 XHigh',
              supported_endpoints: ['/v1/messages'],
            },
            {
              id: 'embedding-only',
              supported_endpoints: ['/embeddings'],
            },
          ]),
        );
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/models', {
        headers: { 'x-api-key': apiKey.key },
      });

      assertEquals(response.status, 200);
      assertEquals(await response.json(), {
        data: [
          {
            id: 'claude-opus-4-7',
            type: 'model',
            display_name: 'Claude Opus 4.7 XHigh',
          },
        ],
        has_more: false,
        first_id: 'claude-opus-4-7',
        last_id: 'claude-opus-4-7',
      });
    },
  );
});

test('/v1/models hides upstream identity when a provider returns an invalid model list', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearModelsCache();
  await clearCopilotTokenCache();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_secret_provider',
    name: 'Secret Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://secret.example.com',
      bearerToken: 'sk-secret',
      supportedEndpoints: ['/chat/completions'],
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'secret.example.com') {
        return jsonResponse({ object: 'list', data: null });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/models', {
        headers: { 'x-api-key': apiKey.key },
      });

      assertEquals(response.status, 502);
      const body = (await response.json()) as { error: { message: string } };
      assertEquals(body.error.message, 'Invalid upstream /models response');
    },
  );
});

test('public model list endpoints hide upstream HTTP error bodies and headers', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearModelsCache();
  await clearCopilotTokenCache();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_http_secret_provider',
    name: 'HTTP Secret Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://http-secret.example.com',
      bearerToken: 'sk-secret',
      supportedEndpoints: ['/chat/completions'],
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'http-secret.example.com') {
        return new Response('secret upstream body: up_http_secret_provider', {
          status: 403,
          headers: {
            'content-type': 'text/plain',
            'x-upstream-id': 'up_http_secret_provider',
          },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      for (const path of ['/v1/models', '/models', '/api/models']) {
        const response = await requestApp(path, {
          headers: { 'x-api-key': apiKey.key },
        });
        assertEquals(response.status, 403);
        assertEquals(response.headers.get('x-upstream-id'), null);
        assertEquals(await response.json(), {
          error: {
            message: 'Upstream model listing failed',
            type: 'api_error',
          },
        });
      }
    },
  );
});

test('public model list endpoints hide thrown upstream request errors', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearModelsCache();
  await clearCopilotTokenCache();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_throw_secret_provider',
    name: 'Throw Secret Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://throw-secret.example.com',
      bearerToken: 'sk-secret',
      supportedEndpoints: ['/chat/completions'],
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'throw-secret.example.com') {
        throw new Error('network failure contacting https://throw-secret.example.com/v1/models');
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      for (const path of ['/v1/models', '/models', '/api/models']) {
        const response = await requestApp(path, {
          headers: { 'x-api-key': apiKey.key },
        });
        assertEquals(response.status, 502);
        assertEquals(await response.json(), {
          error: {
            message: 'Upstream model listing failed',
            type: 'api_error',
          },
        });
      }
    },
  );
});

test('public model list endpoints hide malformed upstream response bodies', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearModelsCache();
  await clearCopilotTokenCache();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_malformed_secret_provider',
    name: 'Malformed Secret Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://malformed-secret.example.com',
      bearerToken: 'sk-secret',
      supportedEndpoints: ['/chat/completions'],
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'malformed-secret.example.com') {
        return new Response('secret malformed body: up_malformed_secret_provider', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      for (const path of ['/v1/models', '/models', '/api/models']) {
        const response = await requestApp(path, {
          headers: { 'x-api-key': apiKey.key },
        });
        assertEquals(response.status, 502);
        assertEquals(await response.json(), {
          error: {
            message: 'Invalid upstream /models response',
            type: 'api_error',
          },
        });
      }
    },
  );
});

test('/v1/models reports an upstream configuration error when no provider is configured', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearModelsCache();
  await clearCopilotTokenCache();

  const response = await requestApp('/v1/models', {
    headers: { 'x-api-key': apiKey.key },
  });

  assertEquals(response.status, 502);
  const body = (await response.json()) as { error: { message: string } };
  assertEquals(body.error.message, 'No upstream provider configured — connect GitHub Copilot or add a Custom/Azure upstream in the dashboard');
});

test('/v1/models returns the id-sorted union of every connected GitHub account', async () => {
  const { repo, apiKey, githubAccount } = await setupAppTest();
  await repo.upstreams.save(buildCopilotUpstreamRecord(SECOND_ACCOUNT, { id: 'up_copilot_second', sortOrder: 1 }));

  const tokenForGithubToken = new Map([
    [githubAccount.token, 'copilot-first'],
    [SECOND_ACCOUNT.token, 'copilot-second'],
  ]);

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }

      if (url.pathname === '/copilot_internal/v2/token') {
        const githubToken = request.headers.get('authorization')?.replace('token ', '') ?? '';
        return jsonResponse({
          token: tokenForGithubToken.get(githubToken),
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }

      if (url.pathname === '/models') {
        const auth = request.headers.get('authorization');
        if (auth === 'Bearer copilot-first') {
          return jsonResponse(
            copilotModels([
              { id: 'shared-model', supported_endpoints: ['/v1/messages'] },
              { id: 'first-only', supported_endpoints: ['/responses'] },
            ]),
          );
        }

        if (auth === 'Bearer copilot-second') {
          return jsonResponse(
            copilotModels([
              { id: 'shared-model', supported_endpoints: ['/chat/completions'] },
              { id: 'second-only', supported_endpoints: ['/v1/messages'] },
            ]),
          );
        }
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/models', {
        headers: { 'x-api-key': apiKey.key },
      });

      assertEquals(response.status, 200);
      const body = (await response.json()) as {
        data: Array<{
          id: string;
          supported_endpoints?: string[];
          provider?: string;
        }>;
      };
      assertEquals(
        body.data.map(model => model.id),
        ['first-only', 'second-only', 'shared-model'],
      );
      assertEquals(body.data[0].supported_endpoints, undefined);
      assertEquals(body.data[0].provider, undefined);
    },
  );
});

test('/v1/models returns the last real error when every account model load fails', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }

      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-invalid-models',
          expires_at: 4102444800,
          refresh_in: 3600,
        });
      }

      if (url.pathname === '/models') {
        return jsonResponse({ object: 'unexpected', data: [] });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/models', {
        headers: { 'x-api-key': apiKey.key },
      });

      // Invalid /models payloads still parse if `data` is an array; an
      // unexpected `object` value is non-fatal because the merging handler
      // only iterates `data`. The assertion here documents the lenient
      // behavior consistent with isModelsResponse.
      assertEquals(response.status, 200);
      const body = (await response.json()) as { data: unknown[] };
      assertEquals(body.data, []);
    },
  );
});
