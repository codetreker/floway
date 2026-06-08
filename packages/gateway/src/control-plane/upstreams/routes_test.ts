import { test } from 'vitest';

import { requestApp, setupAppTest } from '../../test-helpers.ts';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const customConfig = {
  baseUrl: 'https://custom.example.com',
  bearerToken: 'sk-test',
  endpoints: { chatCompletions: {} },
};

const azureConfig = {
  endpoint: 'https://example.openai.azure.com',
  apiKey: 'az-secret',
  models: [
    {
      upstreamModelId: 'gpt-prod',
      publicModelId: 'gpt-public',
      endpoints: { chatCompletions: {}, responses: {} },
    },
  ],
};

const copilotConfig = {
  githubToken: 'ghu_secret',
  accountType: 'individual',
  user: {
    id: 12345,
    login: 'octo',
    name: null,
    avatar_url: 'https://example.com/octo.png',
  },
};

const createBody = (overrides: Record<string, unknown> = {}) => ({
  provider: 'custom',
  name: 'Test custom upstream',
  config: customConfig,
  flag_overrides: {},
  ...overrides,
});

const authed = (adminKey: string, body?: unknown): RequestInit => ({
  method: body === undefined ? 'GET' : 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': adminKey,
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test('POST /api/upstreams creates custom upstreams and redacts bearer tokens', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const resp = await requestApp('/api/upstreams', authed(adminKey, createBody({ flag_overrides: { 'vendor-kimi': true } })));

  assertEquals(resp.status, 201);
  const created = (await resp.json()) as Record<string, any>;
  assertEquals(created.provider, 'custom');
  assertEquals(created.config.bearerToken, undefined);
  assertEquals(created.config.bearerTokenSet, true);
  assertEquals(created.config.baseUrl, 'https://custom.example.com');
  assertEquals(created.flag_overrides, { 'vendor-kimi': true });

  const stored = await repo.upstreams.getById(created.id);
  assertEquals((stored?.config as Record<string, unknown>).bearerToken, 'sk-test');

  const list = await requestApp('/api/upstreams', { headers: { 'x-api-key': adminKey } });
  const items = (await list.json()) as Array<Record<string, any>>;
  assertEquals(items[0].config.bearerToken, undefined);
});

test('POST /api/upstreams validates Azure models and redacts API keys', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const invalid = await requestApp('/api/upstreams', authed(adminKey, createBody({ provider: 'azure', config: { ...azureConfig, models: [] } })));
  assertEquals(invalid.status, 400);
  const invalidBody = (await invalid.json()) as { error?: string };
  assertEquals(invalidBody.error?.includes('models must be a non-empty array'), true);

  const createdResp = await requestApp('/api/upstreams', authed(adminKey, createBody({ provider: 'azure', name: 'Azure', config: azureConfig })));
  assertEquals(createdResp.status, 201);
  const created = (await createdResp.json()) as Record<string, any>;
  assertEquals(created.provider, 'azure');
  assertEquals(created.config.apiKey, undefined);
  assertEquals(created.config.apiKeySet, true);
  assertEquals(created.config.endpoint, 'https://example.openai.azure.com');
  assertEquals(created.config.models[0].upstreamModelId, 'gpt-prod');
});

test('POST /api/upstreams creates Copilot upstream rows with redacted GitHub tokens', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const resp = await requestApp('/api/upstreams', authed(adminKey, createBody({ provider: 'copilot', name: 'Copilot', config: copilotConfig })));

  assertEquals(resp.status, 201);
  const created = (await resp.json()) as Record<string, any>;
  assertEquals(created.provider, 'copilot');
  assertEquals(created.config.githubToken, undefined);
  assertEquals(created.config.githubTokenSet, true);
  assertEquals(created.config.user.id, 12345);

  const stored = await repo.upstreams.getById(created.id);
  assertEquals((stored?.config as Record<string, unknown>).githubToken, 'ghu_secret');
});

test('PATCH /api/upstreams rejects provider changes and preserves the row', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const create = await requestApp('/api/upstreams', authed(adminKey, createBody()));
  const created = (await create.json()) as Record<string, string>;

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-api-key': adminKey,
    },
    body: JSON.stringify({ provider: 'azure' }),
  });

  assertEquals(patch.status, 400);
  assertEquals(((await patch.json()) as { error?: string }).error, 'provider cannot be changed');
  assertEquals((await repo.upstreams.getById(created.id))?.provider, 'custom');
});

test('PATCH /api/upstreams preserves omitted secrets and invalidates model cache', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const create = await requestApp('/api/upstreams', authed(adminKey, createBody()));
  const created = (await create.json()) as Record<string, string>;
  await repo.cache.set(`models_store:${created.id}`, 'stale');

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-api-key': adminKey,
    },
    body: JSON.stringify({ config: { endpoints: { responses: {} } } }),
  });

  assertEquals(patch.status, 200);
  const updated = (await patch.json()) as Record<string, any>;
  assertEquals(updated.config.bearerTokenSet, true);
  const stored = await repo.upstreams.getById(created.id);
  assertEquals((stored?.config as Record<string, unknown>).bearerToken, 'sk-test');
  assertEquals((stored?.config as Record<string, unknown>).endpoints, { responses: {} });
  assertEquals(await repo.cache.get(`models_store:${created.id}`), null);
});

test('PATCH /api/upstreams keeps Azure as a single endpoint config', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save({
    id: 'up_azure_single_endpoint',
    provider: 'azure',
    name: 'Azure Single Endpoint',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    config: {
      endpoint: 'https://example.openai.azure.com/openai/v1',
      apiKey: 'az-secret',
      models: [{ upstreamModelId: 'gpt-prod', endpoints: { messages: {} } }],
    },
    state: null,
  });

  const patch = await requestApp('/api/upstreams/up_azure_single_endpoint', {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-api-key': adminKey,
    },
    body: JSON.stringify({
      config: {
        models: [{ upstreamModelId: 'gpt-prod', endpoints: { responses: {} } }],
      },
    }),
  });

  assertEquals(patch.status, 200);
  const stored = await repo.upstreams.getById('up_azure_single_endpoint');
  assertEquals(stored?.config, {
    endpoint: 'https://example.openai.azure.com/openai/v1',
    apiKey: 'az-secret',
    models: [{ upstreamModelId: 'gpt-prod', kind: 'chat', endpoints: { responses: {} } }],
  });
});

test('GET /api/upstream-flags returns the flag catalog and requires admin auth', async () => {
  const { adminKey, apiKey } = await setupAppTest();

  const resp = await requestApp('/api/upstream-flags', { method: 'GET', headers: { 'x-api-key': adminKey } });
  assertEquals(resp.status, 200);
  const catalog = (await resp.json()) as Array<Record<string, unknown>>;
  const sample = catalog.find(e => e.id === 'vendor-kimi');
  assertEquals(typeof sample?.label, 'string');
  assertEquals(Array.isArray(sample!.defaultFor), true);
  // `appliesTo` was dropped from the catalog during the Feature Flags refactor; guard against silent re-introduction.
  assertEquals('appliesTo' in sample!, false);

  const forbidden = await requestApp('/api/upstream-flags', { method: 'GET', headers: { 'x-api-key': apiKey.key } });
  assertEquals(forbidden.status, 403);
});

test('POST /api/upstreams/fetch-models fetches a draft custom upstream model list', async () => {
  const { adminKey } = await setupAppTest();

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        assertEquals(request.headers.get('authorization'), 'Bearer sk-test');
        return jsonResponse({ object: 'list', data: [{ id: 'gpt-a' }, { id: 'gpt-b', display_name: 'GPT B' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/fetch-models', authed(adminKey, { config: customConfig }));
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { data: Array<Record<string, unknown>> };
      assertEquals(body.data.map(m => m.id), ['gpt-a', 'gpt-b']);
      assertEquals(body.data[1].display_name, 'GPT B');
    },
  );
});

test('POST /api/upstreams/fetch-models substitutes the stored secret when the token is blank', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();
  // Seed a record whose secret differs from the draft fixture so the outgoing
  // header can only carry it when the stored secret is actually loaded — a
  // matching token would not distinguish substitution from leakage of the
  // draft's own (blank) field.
  await repo.upstreams.save({
    id: 'up_stored_secret',
    provider: 'custom',
    name: 'Stored Secret Custom',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    config: { ...customConfig, bearerToken: 'sk-stored-secret' },
    state: null,
  });

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        // The blank bearerToken in the draft must fall back to the stored
        // record's secret rather than fetching unauthenticated.
        assertEquals(request.headers.get('authorization'), 'Bearer sk-stored-secret');
        return jsonResponse({ object: 'list', data: [{ id: 'kept-secret-model' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp(
        '/api/upstreams/fetch-models',
        authed(adminKey, { id: 'up_stored_secret', config: { ...customConfig, bearerToken: '' } }),
      );
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { data: Array<Record<string, unknown>> };
      assertEquals(body.data.map(m => m.id), ['kept-secret-model']);
    },
  );
});

test('POST /api/upstreams/fetch-models surfaces upstream model-listing failures as 502', async () => {
  const { adminKey } = await setupAppTest();

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ error: 'unauthorized' }, 401);
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/fetch-models', authed(adminKey, { config: customConfig }));
      assertEquals(resp.status, 502);
      const body = (await resp.json()) as { error: { message: string; type: string } };
      assertEquals(body.error.type, 'api_error');
    },
  );
});

test('POST /api/upstreams/fetch-models rejects a malformed draft config with 400', async () => {
  const { adminKey } = await setupAppTest();

  // Blank token with no id and no stored secret to substitute: the runtime
  // assert rejects the empty bearerToken, surfaced as a 400 validation error.
  const resp = await requestApp('/api/upstreams/fetch-models', authed(adminKey, { config: { ...customConfig, bearerToken: '' } }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.includes('bearerToken'), true);
});

test('GET /api/upstreams/:id/models resolves a saved upstream catalog and 404s for an unknown id', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = (await (await requestApp('/api/upstreams', authed(adminKey, createBody({ provider: 'azure', name: 'Az', config: azureConfig })))).json()) as { id: string };

  const resp = await requestApp(`/api/upstreams/${created.id}/models`, { headers: { 'x-api-key': adminKey } });
  assertEquals(resp.status, 200);
  const body = (await resp.json()) as { data: Array<{ upstreamModelId: string; kind: string; endpoints: Record<string, unknown> }> };
  assertEquals(body.data[0].upstreamModelId, 'gpt-public');
  assertEquals(body.data[0].kind, 'chat');

  const missing = await requestApp('/api/upstreams/nope/models', { headers: { 'x-api-key': adminKey } });
  assertEquals(missing.status, 404);
});

// --- Codex routes ---
//
// The auth.json import path lets us drive the OAuth ingestion deterministically
// without mocking the token-exchange roundtrip: parseCodexIdTokenClaims decodes
// the id_token JWT directly. Build a fake JWT that carries the identity claims
// the production parser requires.
const encodeBase64Url = (input: string): string =>
  btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fakeIdToken = (claims: Record<string, unknown>): string => {
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = encodeBase64Url(JSON.stringify({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acc_test',
      chatgpt_user_id: 'usr_test',
      chatgpt_plan_type: 'plus',
    },
    'https://api.openai.com/profile': { email: 'alice@example.com' },
    ...claims,
  }));
  return `${header}.${payload}.fake-signature`;
};

const codexAuthJsonImport = (overrides: Record<string, unknown> = {}) => ({
  name: 'ChatGPT Codex',
  auth_json: {
    tokens: {
      access_token: 'at_test',
      refresh_token: 'rt_test',
      id_token: fakeIdToken({}),
    },
    ...overrides,
  },
});

test('POST /api/upstreams/codex-pkce-start returns an authorize URL and stashes the verifier', async () => {
  const { repo, adminKey } = await setupAppTest();

  const resp = await requestApp('/api/upstreams/codex-pkce-start', authed(adminKey, {}));
  assertEquals(resp.status, 200);
  const body = (await resp.json()) as { state: string; authorize_url: string; expires_in_seconds: number };
  assertEquals(typeof body.state, 'string');
  assertEquals(body.authorize_url.startsWith('https://auth.openai.com/oauth/authorize?'), true);
  assertEquals(body.expires_in_seconds, 300);

  const stashed = await repo.cache.get(`codex_oauth_pending:${body.state}`);
  assertEquals(typeof stashed, 'string');
  const parsed = JSON.parse(stashed!) as { verifier: string; created_at: string };
  assertEquals(typeof parsed.verifier, 'string');
});

test('POST /api/upstreams/codex-import (auth_json) creates a codex upstream with state', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const resp = await requestApp('/api/upstreams/codex-import', authed(adminKey, codexAuthJsonImport()));
  assertEquals(resp.status, 201);
  const created = (await resp.json()) as Record<string, any>;
  assertEquals(created.provider, 'codex');
  assertEquals(created.config.accounts[0].email, 'alice@example.com');
  assertEquals(created.config.accounts[0].chatgptAccountId, 'acc_test');
  assertEquals(created.config.accounts[0].planType, 'plus');
  assertEquals(created.state.accounts[0].state, 'active');
  assertEquals(created.state.accounts[0].refresh_token_set, true);

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ refresh_token: string }> };
  assertEquals(storedState.accounts[0].refresh_token, 'rt_test');
});

test('POST /api/upstreams/codex-import without an explicit name auto-derives one from the imported identity', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const { name: _ignored, ...bodyWithoutName } = codexAuthJsonImport();
  const resp = await requestApp('/api/upstreams/codex-import', authed(adminKey, bodyWithoutName));
  assertEquals(resp.status, 201);
  const created = (await resp.json()) as { name: string };
  assertEquals(created.name, 'ChatGPT Codex (alice@example.com)');
});

test('POST /api/upstreams/codex-import rejects when both auth_json and callback are absent', async () => {
  const { adminKey } = await setupAppTest();

  const resp = await requestApp('/api/upstreams/codex-import', authed(adminKey, { name: 'ChatGPT Codex' }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: { issues?: Array<{ message: string }> } | string };
  // The schema-level XOR refine surfaces as a zod validation error envelope.
  assertEquals(JSON.stringify(body).includes('Provide exactly one of auth_json or callback'), true);
});

test('POST /api/upstreams/codex-import rejects a malformed PKCE callback URL', async () => {
  const { adminKey } = await setupAppTest();

  const resp = await requestApp(
    '/api/upstreams/codex-import',
    authed(adminKey, { name: 'Codex', callback: { callback_url: 'http://localhost:1455/auth/callback' } }),
  );
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  // The handler unwraps the URL and reports "missing `code`" before ever
  // touching the token endpoint.
  assertEquals(body.error.includes('missing'), true);
});

test('POST /api/upstreams/:id/codex-refresh-now rejects non-codex rows with 404', async () => {
  const { adminKey } = await setupAppTest();

  const created = (await (await requestApp('/api/upstreams', authed(adminKey, createBody()))).json()) as { id: string };
  const resp = await requestApp(`/api/upstreams/${created.id}/codex-refresh-now`, authed(adminKey, {}));
  assertEquals(resp.status, 404);
});

test('POST /api/upstreams/:id/codex-refresh-now rejects upstreams in a terminal state with 400', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  // Plant a codex upstream in `session_terminated` state by importing then
  // hand-mutating the row (the routes never expose a way to get into this
  // state without a real upstream 401).
  const created = (await (await requestApp('/api/upstreams/codex-import', authed(adminKey, codexAuthJsonImport()))).json()) as { id: string };
  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored!.state as { accounts: Array<Record<string, unknown>> };
  await repo.upstreams.save({
    ...stored!,
    state: { accounts: storedState.accounts.map(a => ({ ...a, state: 'session_terminated' })) },
  });

  const resp = await requestApp(`/api/upstreams/${created.id}/codex-refresh-now`, authed(adminKey, {}));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.includes('session_terminated'), true);
});

test('POST /api/upstreams/:id/codex-refresh-now rotates the refresh token on success', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = (await (await requestApp('/api/upstreams/codex-import', authed(adminKey, codexAuthJsonImport()))).json()) as { id: string };

  await withMockedFetch(
    () => jsonResponse({
      access_token: 'at_rotated',
      refresh_token: 'rt_rotated',
      id_token: fakeIdToken({}),
      expires_in: 3600,
    }),
    async () => {
      const resp = await requestApp(`/api/upstreams/${created.id}/codex-refresh-now`, authed(adminKey, {}));
      assertEquals(resp.status, 200);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ refresh_token: string }> };
  assertEquals(storedState.accounts[0].refresh_token, 'rt_rotated');
});

test('POST /api/upstreams/:id/codex-refresh-now flips the row to refresh_failed when OAuth rejects the refresh_token', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = (await (await requestApp('/api/upstreams/codex-import', authed(adminKey, codexAuthJsonImport()))).json()) as { id: string };

  await withMockedFetch(
    () => new Response(
      JSON.stringify({ error: { code: 'invalid_grant', message: 'Your refresh token has already been used to generate a new access token.' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ),
    async () => {
      const resp = await requestApp(`/api/upstreams/${created.id}/codex-refresh-now`, authed(adminKey, {}));
      // 502, not 401 — the dashboard's auth client treats any 401 as a
      // logout signal, and a dead codex credential must not log the
      // operator out of the dashboard.
      assertEquals(resp.status, 502);
      const body = await resp.json() as { error: string };
      assertEquals(body.error.includes('Re-import'), true);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ state: string; state_message?: string }> };
  assertEquals(storedState.accounts[0].state, 'refresh_failed');
  assertEquals(typeof storedState.accounts[0].state_message, 'string');
});

test('POST /api/upstreams/:id/codex-refresh-now still answers when the failure-state CAS write loses to a concurrent mutation', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = (await (await requestApp('/api/upstreams/codex-import', authed(adminKey, codexAuthJsonImport()))).json()) as { id: string };

  // Race: another writer rotates the refresh_token between our read and our
  // failure-state CAS write. The route should still respond — the concurrent
  // writer's state is fresher than our `refresh_failed` proposal by
  // construction, so we drop ours rather than overwrite theirs.
  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored!.state as { accounts: Array<Record<string, unknown>> };

  await withMockedFetch(
    () => {
      // Simulate the concurrent writer mid-OAuth by mutating the row before
      // the route reaches its CAS write. The OAuth call itself fails terminally.
      void repo.upstreams.save({
        ...stored!,
        state: { accounts: storedState.accounts.map(a => ({ ...a, refresh_token: 'rt_concurrent_winner' })) },
      });
      return new Response(
        JSON.stringify({ error: { code: 'invalid_grant', message: 'Your refresh token has already been used to generate a new access token.' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    },
    async () => {
      const resp = await requestApp(`/api/upstreams/${created.id}/codex-refresh-now`, authed(adminKey, {}));
      assertEquals(resp.status, 502);
    },
  );

  // The concurrent writer's state survives — our refresh_failed write was
  // dropped by the CAS guard, which is the intended best-effort behavior.
  const after = await repo.upstreams.getById(created.id);
  const afterState = after?.state as { accounts: Array<{ state: string; refresh_token: string }> };
  assertEquals(afterState.accounts[0].refresh_token, 'rt_concurrent_winner');
  assertEquals(afterState.accounts[0].state, 'active');
});
