import { test } from 'vitest';

import { setupAppTest } from '../../test-helpers.ts';
import {
  clearModelsStore,
  inProcessMemo,
  invalidateModelsStore,
  ProviderModelsUnavailableError,
  readModelsStore,
  writeModelsStore,
} from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

test('inProcessMemo returns the cached value within TTL', async () => {
  clearModelsStore();
  let calls = 0;
  const load = () => inProcessMemo('memo-key', 60_000, async () => { calls++; return calls; });

  assertEquals(await load(), 1);
  assertEquals(await load(), 1);
  assertEquals(calls, 1);
});

test('inProcessMemo re-runs the loader after TTL elapses', async () => {
  clearModelsStore();
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    let calls = 0;
    const load = () => inProcessMemo('memo-key-ttl', 1000, async () => { calls++; return calls; });

    assertEquals(await load(), 1);
    now += 500;
    assertEquals(await load(), 1);
    now += 600;
    assertEquals(await load(), 2);
  } finally {
    Date.now = originalNow;
  }
});

test('inProcessMemo shares a single in-flight promise across concurrent callers', async () => {
  clearModelsStore();
  let calls = 0;
  const load = () =>
    inProcessMemo('memo-key-concurrent', 60_000, async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 5));
      return calls;
    });

  const [a, b, c] = await Promise.all([load(), load(), load()]);
  assertEquals(a, 1);
  assertEquals(b, 1);
  assertEquals(c, 1);
  assertEquals(calls, 1);
});

test('inProcessMemo clears the entry on rejection so the next call retries', async () => {
  clearModelsStore();
  let calls = 0;
  const load = () =>
    inProcessMemo('memo-key-retry', 60_000, async () => {
      calls++;
      if (calls === 1) throw new Error('first attempt');
      return calls;
    });

  let threw = false;
  try { await load(); } catch { threw = true; }
  assertEquals(threw, true);
  assertEquals(await load(), 2);
  assertEquals(calls, 2);
});

test('readModelsStore and writeModelsStore round-trip JSON via the repo cache', async () => {
  await setupAppTest();
  clearModelsStore();

  await writeModelsStore('up_1', { hello: 'world', n: 42 });
  const got = await readModelsStore<{ hello: string; n: number }>('up_1');
  assertEquals(got?.hello, 'world');
  assertEquals(got?.n, 42);
});

test('readModelsStore returns null for missing or unparseable entries', async () => {
  const { repo } = await setupAppTest();
  clearModelsStore();

  assertEquals(await readModelsStore('missing'), null);
  await repo.cache.set('models_store:bad', 'not json {');
  assertEquals(await readModelsStore('bad'), null);
});

test('invalidateModelsStore drops the in-process and repo entries for one upstream', async () => {
  await setupAppTest();
  clearModelsStore();

  let calls = 0;
  const load = () => inProcessMemo('up_2', 60_000, async () => { calls++; return calls; });

  assertEquals(await load(), 1);
  await writeModelsStore('up_2', { value: 'persisted' });

  await invalidateModelsStore('up_2');

  assertEquals(await load(), 2);
  assertEquals(await readModelsStore('up_2'), null);
});

test('ProviderModelsUnavailableError carries httpResponse when present and cause when given', () => {
  const headers = new Headers({ 'content-type': 'application/json' });
  const httpErr = new ProviderModelsUnavailableError({ status: 503, headers, body: 'oops' });
  assertEquals(httpErr.httpResponse?.status, 503);
  assertEquals(httpErr.httpResponse?.body, 'oops');
  assertEquals(httpErr.name, 'ProviderModelsUnavailableError');

  const cause = new Error('network');
  const networkErr = new ProviderModelsUnavailableError(null, cause);
  assertEquals(networkErr.httpResponse, null);
  assertEquals(networkErr.cause, cause);
});
