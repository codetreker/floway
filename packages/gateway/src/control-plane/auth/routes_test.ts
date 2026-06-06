import { test } from 'vitest';

import { buildCopilotUpstreamRecord, requestApp, setupAppTest } from '../../test-helpers.ts';
import { assertEquals, assertStringIncludes, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const githubUser = {
  id: 777,
  login: 'octo-auth',
  name: 'Octo Auth',
  avatar_url: 'https://example.com/octo-auth.png',
};

test('/auth/me returns only auth identity', async () => {
  const { adminKey } = await setupAppTest();

  const response = await requestApp('/auth/me', {
    method: 'GET',
    headers: { 'x-api-key': adminKey },
  });

  assertEquals(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assertEquals(body.authenticated, true);
  assertEquals(body.isAdmin, true);
  assertEquals('accounts' in body, false);
  assertEquals('github_connected' in body, false);
});

test('old /auth GitHub management routes are removed', async () => {
  const { adminKey } = await setupAppTest();

  const start = await requestApp('/auth/github', { method: 'GET', headers: { 'x-api-key': adminKey } });
  const order = await requestApp('/auth/github/order', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': adminKey,
    },
    body: JSON.stringify({ user_ids: [1] }),
  });

  assertEquals(start.status, 404);
  assertEquals(order.status, 404);
});

test('/api/upstreams/copilot/auth/start starts GitHub device flow', async () => {
  const { adminKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'github.com' && url.pathname === '/login/device/code') {
        return jsonResponse({ device_code: 'device', user_code: 'ABCD', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/api/upstreams/copilot/auth/start', { method: 'POST', headers: { 'x-api-key': adminKey } });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), { device_code: 'device', user_code: 'ABCD', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    },
  );
});

test('/api/upstreams/copilot/auth/poll creates a Copilot upstream row', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') return jsonResponse({ access_token: 'ghu_new' });
      if (url.hostname === 'api.github.com' && url.pathname === '/user') return jsonResponse(githubUser);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.hostname === 'api.github.com' && url.pathname === '/copilot_internal/user') return jsonResponse({ copilot_plan: 'enterprise' });
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/api/upstreams/copilot/auth/poll', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': adminKey,
        },
        body: JSON.stringify({ device_code: 'device' }),
      });

      assertEquals(response.status, 200);
      const body = (await response.json()) as Record<string, any>;
      assertEquals(body.status, 'complete');
      assertEquals(/^up_[0-9a-f]{24}$/.test(body.upstream.id), true);
      assertEquals(body.upstream.id.includes('copilot'), false);
      assertEquals(body.upstream.provider, 'copilot');
      assertEquals(body.upstream.config.githubToken, undefined);
      assertEquals(body.upstream.config.githubTokenSet, true);
    },
  );

  const rows = await repo.upstreams.list();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].provider, 'copilot');
  assertEquals((rows[0].config as Record<string, any>).githubToken, 'ghu_new');
  assertEquals((rows[0].config as Record<string, any>).accountType, 'enterprise');
  assertEquals((rows[0].config as Record<string, any>).user.id, 777);
});

test('/api/upstreams/copilot/auth/poll rejects failed GitHub user lookup without saving an upstream', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') return jsonResponse({ access_token: 'ghu_no_user' });
      if (url.hostname === 'api.github.com' && url.pathname === '/user') return jsonResponse({ message: 'bad credentials' }, 401);
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/api/upstreams/copilot/auth/poll', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': adminKey,
        },
        body: JSON.stringify({ device_code: 'device' }),
      });

      assertEquals(response.status, 502);
      const body = (await response.json()) as { error: string };
      assertStringIncludes(body.error, 'GitHub user lookup failed: 401');
      assertStringIncludes(body.error, 'bad credentials');
    },
  );

  assertEquals(await repo.upstreams.list(), []);
});

test('/api/upstreams/copilot/auth/poll rejects failed Copilot account type lookup without saving an upstream', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') return jsonResponse({ access_token: 'ghu_no_plan' });
      if (url.hostname === 'api.github.com' && url.pathname === '/user') return jsonResponse(githubUser);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.hostname === 'api.github.com' && url.pathname === '/copilot_internal/user') return jsonResponse({ message: 'no copilot seat' }, 403);
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/api/upstreams/copilot/auth/poll', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': adminKey,
        },
        body: JSON.stringify({ device_code: 'device' }),
      });

      assertEquals(response.status, 502);
      const body = (await response.json()) as { error: string };
      assertStringIncludes(body.error, 'GitHub Copilot account type detection failed: 403');
      assertStringIncludes(body.error, 'no copilot seat');
    },
  );

  assertEquals(await repo.upstreams.list(), []);
});

test('/api/upstreams/copilot/auth/poll rejects unknown Copilot account type without saving an upstream', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') return jsonResponse({ access_token: 'ghu_unknown_plan' });
      if (url.hostname === 'api.github.com' && url.pathname === '/user') return jsonResponse(githubUser);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.hostname === 'api.github.com' && url.pathname === '/copilot_internal/user') return jsonResponse({ copilot_plan: 'free' });
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/api/upstreams/copilot/auth/poll', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': adminKey,
        },
        body: JSON.stringify({ device_code: 'device' }),
      });

      assertEquals(response.status, 502);
      assertEquals((await response.json()) as Record<string, unknown>, { error: 'Unknown GitHub Copilot plan: free' });
    },
  );

  assertEquals(await repo.upstreams.list(), []);
});

test('/api/upstreams/copilot/auth/poll updates an existing row for the same GitHub user', async () => {
  const { repo, adminKey, githubAccount } = await setupAppTest({
    githubAccount: {
      token: 'ghu_old',
      accountType: 'individual',
      user: githubUser,
    },
  });
  const existing = buildCopilotUpstreamRecord(githubAccount, { id: 'up_existing_copilot', name: 'Pinned Copilot', sortOrder: 9 });
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(existing);
  await repo.cache.set('models_store:up_existing_copilot', 'stale');

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') return jsonResponse({ access_token: 'ghu_refreshed' });
      if (url.hostname === 'api.github.com' && url.pathname === '/user') return jsonResponse(githubUser);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.hostname === 'api.github.com' && url.pathname === '/copilot_internal/user') return jsonResponse({ copilot_plan: 'business' });
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/api/upstreams/copilot/auth/poll', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': adminKey,
        },
        body: JSON.stringify({ device_code: 'device' }),
      });
      assertEquals(response.status, 200);
      assertEquals(((await response.json()) as Record<string, any>).upstream.id, 'up_existing_copilot');
    },
  );

  const rows = await repo.upstreams.list();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].id, 'up_existing_copilot');
  assertEquals(rows[0].name, 'Pinned Copilot');
  assertEquals(rows[0].sortOrder, 9);
  assertEquals((rows[0].config as Record<string, any>).githubToken, 'ghu_refreshed');
  assertEquals((rows[0].config as Record<string, any>).accountType, 'business');
  assertEquals(await repo.cache.get('models_store:up_existing_copilot'), null);
});
