import { Hono } from 'hono';
import { test } from 'vitest';

import { searchUsage } from './routes.ts';
import { zValidator } from '../../middleware/zod-validator.ts';
import { initRepo } from '../../repo/index.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import type { ApiKey, SearchUsageRecord } from '../../repo/types.ts';
import { searchUsageQuery } from '../schemas.ts';
import { assertEquals } from '@floway-dev/test-utils';

const KEY_A: ApiKey = {
  id: 'key-aaa',
  name: 'Alice',
  key: 'raw-key-aaa',
  createdAt: '2026-01-01T00:00:00.000Z',
  upstreamIds: null,
};

const KEY_B: ApiKey = {
  id: 'key-bbb',
  name: 'Bob',
  key: 'raw-key-bbb',
  createdAt: '2026-02-01T00:00:00.000Z',
  upstreamIds: null,
};

const SEARCH_USAGE_A: SearchUsageRecord = {
  provider: 'tavily',
  keyId: KEY_A.id,
  action: 'search',
  hour: '2026-03-15T10',
  requests: 2,
};

const SEARCH_USAGE_A_FETCH: SearchUsageRecord = {
  provider: 'tavily',
  keyId: KEY_A.id,
  action: 'fetch_page',
  hour: '2026-03-15T10',
  requests: 3,
};

const SEARCH_USAGE_B: SearchUsageRecord = {
  provider: 'microsoft-grounding',
  keyId: KEY_B.id,
  action: 'search',
  hour: '2026-03-15T11',
  requests: 4,
};

const setup = async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const app = new Hono();
  app.get('/api/search-usage', zValidator('query', searchUsageQuery), searchUsage);

  await repo.apiKeys.save(KEY_A);
  await repo.apiKeys.save(KEY_B);
  await repo.searchUsage.set(SEARCH_USAGE_A);
  await repo.searchUsage.set(SEARCH_USAGE_A_FETCH);
  await repo.searchUsage.set(SEARCH_USAGE_B);

  return { app, repo };
};

test('/api/search-usage sums requests across actions and includes key metadata', async () => {
  // The dashboard sees one row per (provider, keyId, hour) with
  // search and fetch_page request counts summed. KEY_A has both a `search`
  // (2 req) and a `fetch_page` (3 req) record at the same hour; the
  // aggregated row exposes 5.
  const { app, repo } = await setup();
  await repo.searchConfig.save({
    provider: 'microsoft-grounding',
    tavily: { apiKey: 'tvly-test' },
    microsoftGrounding: { apiKey: 'ms-test' },
  });

  const response = await app.request('/api/search-usage?start=2026-03-15T00&end=2026-03-16T00&include_key_metadata=1');

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.activeProvider, 'microsoft-grounding');
  assertEquals(Array.isArray(body.keyColorOrder), true);
  assertEquals(body.keys, [
    { id: KEY_A.id, name: KEY_A.name, createdAt: KEY_A.createdAt },
    { id: KEY_B.id, name: KEY_B.name, createdAt: KEY_B.createdAt },
  ]);
  assertEquals(body.records, [
    {
      provider: 'tavily',
      keyId: KEY_A.id,
      hour: '2026-03-15T10',
      requests: 5,
      keyName: KEY_A.name,
      keyCreatedAt: KEY_A.createdAt,
    },
    {
      provider: 'microsoft-grounding',
      keyId: KEY_B.id,
      hour: '2026-03-15T11',
      requests: 4,
      keyName: KEY_B.name,
      keyCreatedAt: KEY_B.createdAt,
    },
  ]);
});

test('/api/search-usage filters by provider and rejects invalid provider', async () => {
  const { app } = await setup();

  // Without include_key_metadata=1 the response is the bare aggregated
  // records — no per-record keyName/keyCreatedAt enrichment and no
  // apiKeys.list() round-trip.
  const filtered = await app.request('/api/search-usage?start=2026-03-15T00&end=2026-03-16T00&provider=tavily');
  assertEquals(filtered.status, 200);
  assertEquals(await filtered.json(), [
    {
      provider: 'tavily',
      keyId: KEY_A.id,
      hour: '2026-03-15T10',
      requests: 5,
    },
  ]);

  const invalid = await app.request('/api/search-usage?start=2026-03-15T00&end=2026-03-16T00&provider=disabled');
  assertEquals(invalid.status, 400);
});

test('/api/search-usage requires start and end', async () => {
  const { app } = await setup();

  const missingStart = await app.request('/api/search-usage?end=2026-03-16T00');
  assertEquals(missingStart.status, 400);
  assertEquals(await missingStart.json(), {
    error: 'start and end query parameters are required (e.g. 2026-03-09T00)',
  });

  const missingEnd = await app.request('/api/search-usage?start=2026-03-15T00');
  assertEquals(missingEnd.status, 400);
  assertEquals(await missingEnd.json(), {
    error: 'start and end query parameters are required (e.g. 2026-03-09T00)',
  });
});
