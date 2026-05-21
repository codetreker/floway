import { test } from 'vitest';

import { clearModelsCache, invalidateUpstreamModels, loadModels } from './upstream-model-cache.ts';
import { clearCopilotTokenCache } from '../../shared/copilot.ts';
import { createCopilotUpstream } from '../../shared/upstream/copilot.ts';
import { assertEquals } from '../../test-assert.ts';
import { copilotModels, jsonResponse, setupAppTest, withMockedFetch } from '../../test-helpers.ts';

function withFakeNow<T>(times: number[], run: () => Promise<T>): Promise<T> {
  const originalNow = Date.now;
  let index = 0;
  Date.now = () => times[Math.min(index++, times.length - 1)];
  return run().finally(() => {
    Date.now = originalNow;
  });
}

function withMutableNow<T>(initial: number, run: (setNow: (value: number) => void) => Promise<T>): Promise<T> {
  const originalNow = Date.now;
  let now = initial;
  Date.now = () => now;
  return run(value => {
    now = value;
  }).finally(() => {
    Date.now = originalNow;
  });
}

const loadModelData = async (upstream: Parameters<typeof loadModels>[0]) => {
  const result = await loadModels(upstream);
  if (result.type === 'error') throw result.error;
  return result.data;
};

test('models cache uses L1 cache for 120s and L2 cache for 600s', async () => {
  const { githubAccount } = await setupAppTest();
  clearModelsCache();
  await clearCopilotTokenCache();

  const upstream = await createCopilotUpstream(githubAccount.token, githubAccount.accountType);

  let modelsFetches = 0;

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
        modelsFetches++;
        return jsonResponse({
          object: 'list',
          data: [
            {
              id: 'claude-sonnet-4',
              name: 'claude-sonnet-4',
              version: '1',
              object: 'model',
              supported_endpoints: ['/v1/messages'],
              capabilities: {
                family: 'claude',
                type: 'chat',
                limits: {},
                supports: {},
              },
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      await withFakeNow([0, 60_000, 130_000], async () => {
        const first = await loadModelData(upstream);
        const second = await loadModelData(upstream);
        const third = await loadModelData(upstream);

        assertEquals(first.data[0].id, 'claude-sonnet-4');
        assertEquals(second.data[0].id, 'claude-sonnet-4');
        assertEquals(third.data[0].id, 'claude-sonnet-4');
      });
    },
  );

  assertEquals(modelsFetches, 1);
});

test('models cache refreshes upstream after repo-backed cache expires', async () => {
  const { githubAccount } = await setupAppTest();
  clearModelsCache();
  await clearCopilotTokenCache();

  const upstream = await createCopilotUpstream(githubAccount.token, githubAccount.accountType);

  let modelsFetches = 0;

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
        modelsFetches++;
        return jsonResponse({
          object: 'list',
          data: [
            {
              id: `model-${modelsFetches}`,
              name: `model-${modelsFetches}`,
              version: '1',
              object: 'model',
              supported_endpoints: ['/responses'],
              capabilities: {
                family: 'gpt',
                type: 'chat',
                limits: {},
                supports: {},
              },
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      await withFakeNow([0, 610_000], async () => {
        const first = await loadModelData(upstream);
        const second = await loadModelData(upstream);

        assertEquals(first.data[0].id, 'model-1');
        assertEquals(second.data[0].id, 'model-2');
      });
    },
  );

  assertEquals(modelsFetches, 2);
});

test('models cache ignores malformed repo-backed entries', async () => {
  const { githubAccount, repo } = await setupAppTest();
  clearModelsCache();
  await clearCopilotTokenCache();

  const upstream = await createCopilotUpstream(githubAccount.token, githubAccount.accountType);

  await repo.cache.set(
    `models_cache_v2:${upstream.id}`,
    JSON.stringify({
      fetchedAt: 0,
      hardExpiresAt: 7_200_000,
      data: {
        object: 'list',
        data: [{ id: 123, name: 'bad' }],
      },
    }),
  );

  let modelsFetches = 0;

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
        modelsFetches++;
        return jsonResponse({
          object: 'list',
          data: [
            {
              id: 'fresh-model',
              name: 'fresh-model',
              version: '1',
              object: 'model',
              supported_endpoints: ['/responses'],
              capabilities: {
                family: 'gpt',
                type: 'chat',
                limits: {},
                supports: {},
              },
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      await withFakeNow([0], async () => {
        const models = await loadModelData(upstream);

        assertEquals(models.data[0].id, 'fresh-model');
      });
    },
  );

  assertEquals(modelsFetches, 1);
});

test('models cache uses stale data after soft expiry on configured load errors until hard expiry', async () => {
  const { githubAccount } = await setupAppTest();
  clearModelsCache();
  await clearCopilotTokenCache();

  const upstream = await createCopilotUpstream(githubAccount.token, githubAccount.accountType);

  let modelsFetches = 0;

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
        modelsFetches++;
        if (modelsFetches === 1) {
          return jsonResponse(copilotModels([{ id: 'stale-model', supported_endpoints: ['/v1/messages'] }]));
        }
        return jsonResponse({ error: { message: 'rate limited' } }, 429);
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      await withMutableNow(0, async setNow => {
        const fresh = await loadModels(upstream);
        assertEquals(fresh.type, 'models');
        if (fresh.type === 'models') {
          assertEquals(fresh.stale, false);
          assertEquals(fresh.data.data[0].id, 'stale-model');
        }

        setNow(610_000);
        const stale = await loadModels(upstream);
        assertEquals(stale.type, 'models');
        if (stale.type === 'models') {
          assertEquals(stale.stale, true);
          assertEquals(stale.data.data[0].id, 'stale-model');
        }

        setNow(7_201_000);
        const expired = await loadModels(upstream);
        assertEquals(expired.type, 'error');
      });
    },
  );

  assertEquals(modelsFetches, 3);
});

test('invalidateUpstreamModels clears both L1 and L2 cache for a given upstream', async () => {
  const { githubAccount } = await setupAppTest();
  clearModelsCache();
  await clearCopilotTokenCache();

  const upstream = await createCopilotUpstream(githubAccount.token, githubAccount.accountType);

  let modelsFetches = 0;

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
        modelsFetches++;
        return jsonResponse({
          object: 'list',
          data: [
            {
              id: `model-${modelsFetches}`,
              version: '1',
              object: 'model',
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      // First fetch populates both caches
      const first = await loadModelData(upstream);
      assertEquals(first.data[0].id, 'model-1');
      assertEquals(modelsFetches, 1);

      // Within L1 TTL (120s) — should use cache
      const second = await loadModelData(upstream);
      assertEquals(second.data[0].id, 'model-1');
      assertEquals(modelsFetches, 1, 'should not re-fetch within L1 TTL');

      // Invalidate the upstream models
      await invalidateUpstreamModels(upstream.id);

      // After invalidation, should re-fetch
      const third = await loadModelData(upstream);
      assertEquals(third.data[0].id, 'model-2');
      assertEquals(modelsFetches, 2, 'invalidation should trigger re-fetch');
    },
  );
});
