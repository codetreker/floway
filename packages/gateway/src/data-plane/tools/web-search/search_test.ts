import { test } from 'vitest';

import { searchWebAndRecordUsage } from './search.ts';
import type { WebSearchProvider, WebSearchProviderResult } from './types.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const stubProvider = (search: WebSearchProvider['search']): WebSearchProvider => ({
  search,
  fetchPage: () => Promise.reject(new Error('fetchPage should not be called from search test')),
});

test('searchWebAndRecordUsage records successful provider calls', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  const result = await searchWebAndRecordUsage({
    providerName: 'tavily',
    keyId: 'key_a',
    request: { query: 'React' },
    provider: stubProvider(() => Promise.resolve({ type: 'ok', results: [] })),
  });

  assertEquals(result, { type: 'ok', results: [] });
  const records = await repo.searchUsage.listAll();
  assertEquals(records.length, 1);
  assertEquals(records[0].provider, 'tavily');
  assertEquals(records[0].keyId, 'key_a');
  assertEquals(records[0].requests, 1);
});

test('searchWebAndRecordUsage records provider error results', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  const result = await searchWebAndRecordUsage({
    providerName: 'microsoft-grounding',
    keyId: 'key_b',
    request: { query: 'React' },
    provider: stubProvider(() =>
      Promise.resolve<WebSearchProviderResult>({
        type: 'error',
        errorCode: 'unavailable',
        message: 'provider unavailable',
      })),
  });

  assertEquals(result.type, 'error');
  const records = await repo.searchUsage.listAll();
  assertEquals(records.length, 1);
  assertEquals(records[0].provider, 'microsoft-grounding');
  assertEquals(records[0].keyId, 'key_b');
  assertEquals(records[0].requests, 1);
});

test('searchWebAndRecordUsage records when a provider throws', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  await assertRejects(
    () =>
      searchWebAndRecordUsage({
        providerName: 'tavily',
        keyId: 'key_c',
        request: { query: 'React' },
        provider: stubProvider(() => Promise.reject(new Error('network failed'))),
      }),
    Error,
    'network failed',
  );

  const records = await repo.searchUsage.listAll();
  assertEquals(records.length, 1);
  assertEquals(records[0].provider, 'tavily');
  assertEquals(records[0].keyId, 'key_c');
  assertEquals(records[0].requests, 1);
});

test('searchWebAndRecordUsage returns provider result when recording fails', async () => {
  const repo = new InMemoryRepo();
  repo.searchUsage.record = () => Promise.reject(new Error('write failed'));
  initRepo(repo);

  const originalConsoleError = console.error;
  const loggedErrors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args);
  };

  let result: Awaited<ReturnType<typeof searchWebAndRecordUsage>> | undefined;
  try {
    result = await searchWebAndRecordUsage({
      providerName: 'tavily',
      keyId: 'key_d',
      request: { query: 'React' },
      provider: stubProvider(() => Promise.resolve({ type: 'ok', results: [] })),
    });
  } finally {
    console.error = originalConsoleError;
  }

  assertEquals(result, { type: 'ok', results: [] });
  assertEquals(loggedErrors.length, 1);
});
