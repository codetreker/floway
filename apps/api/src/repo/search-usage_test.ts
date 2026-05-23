import { test } from 'vitest';

import { assertEquals, assertRejects } from '../test-assert.ts';
import { type D1Database, D1Repo } from './d1.ts';
import { InMemoryRepo } from './memory.ts';
import type { SearchUsageRecord, SearchUsageRepo } from './types.ts';

const sortSearchUsageRecords = (records: SearchUsageRecord[]) => records.toSorted((a, b) => a.hour.localeCompare(b.hour) || a.provider.localeCompare(b.provider) || a.keyId.localeCompare(b.keyId));

const exerciseSearchUsageRepo = async (repo: SearchUsageRepo) => {
  await repo.deleteAll();
  await repo.record('tavily', 'key_a', '2026-04-25T10', 1);
  await repo.record('tavily', 'key_a', '2026-04-25T10', 2);
  await repo.record('microsoft-grounding', 'key_a', '2026-04-25T11', 4);
  await repo.record('tavily', 'key_b', '2026-04-25T12', 8);
  await repo.record('tavily', 'key_a', '2026-04-25T13', 16);

  assertEquals(
    await repo.query({
      provider: 'tavily',
      start: '2026-04-25T10',
      end: '2026-04-25T13',
    }),
    [
      {
        provider: 'tavily',
        keyId: 'key_a',
        hour: '2026-04-25T10',
        requests: 3,
      },
      {
        provider: 'tavily',
        keyId: 'key_b',
        hour: '2026-04-25T12',
        requests: 8,
      },
    ],
  );

  assertEquals(
    await repo.query({
      keyId: 'key_a',
      start: '2026-04-25T10',
      end: '2026-04-25T14',
    }),
    [
      {
        provider: 'tavily',
        keyId: 'key_a',
        hour: '2026-04-25T10',
        requests: 3,
      },
      {
        provider: 'microsoft-grounding',
        keyId: 'key_a',
        hour: '2026-04-25T11',
        requests: 4,
      },
      {
        provider: 'tavily',
        keyId: 'key_a',
        hour: '2026-04-25T13',
        requests: 16,
      },
    ],
  );

  await repo.set({
    provider: 'tavily',
    keyId: 'key_a',
    hour: '2026-04-25T10',
    requests: 7,
  });
  assertEquals(
    await repo.query({
      provider: 'tavily',
      keyId: 'key_a',
      start: '2026-04-25T10',
      end: '2026-04-25T11',
    }),
    [
      {
        provider: 'tavily',
        keyId: 'key_a',
        hour: '2026-04-25T10',
        requests: 7,
      },
    ],
  );

  await repo.deleteAll();
  assertEquals(await repo.listAll(), []);
};

const assertRejectsInvalidProvider = async (repo: SearchUsageRepo) => {
  await repo.deleteAll();

  await assertRejects(() => repo.record('disabled' as SearchUsageRecord['provider'], 'key_a', '2026-04-25T10', 1), TypeError, 'Invalid web search provider');

  await assertRejects(
    () =>
      repo.set({
        provider: 'disabled' as SearchUsageRecord['provider'],
        keyId: 'key_a',
        hour: '2026-04-25T10',
        requests: 1,
      }),
    TypeError,
    'Invalid web search provider',
  );
};

test('memory search usage repo records, queries, overwrites, and clears', async () => {
  await exerciseSearchUsageRepo(new InMemoryRepo().searchUsage);
});

test('memory search usage repo rejects invalid provider names', async () => {
  await assertRejectsInvalidProvider(new InMemoryRepo().searchUsage);
});

class FakeD1PreparedStatement {
  private binds: unknown[] = [];

  constructor(private db: FakeD1Database, private query: string) {}

  bind(...values: unknown[]): FakeD1PreparedStatement {
    this.binds = values;
    return this;
  }

  first(): Promise<null> {
    throw new Error(`Unsupported D1 first() query in search usage test: ${this.query}`);
  }

  all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    if (this.query.includes('FROM search_usage')) {
      return Promise.resolve({
        results: this.db.select(this.query, this.binds) as T[],
        success: true,
        meta: {},
      });
    }

    throw new Error(`Unsupported D1 all() query in search usage test: ${this.query}`);
  }

  run(): Promise<{ results: never[]; success: true; meta: Record<string, unknown> }> {
    if (this.query.startsWith('INSERT INTO search_usage')) {
      this.db.upsert(this.query, this.binds);
      return Promise.resolve({ results: [], success: true, meta: {} });
    }
    if (this.query === 'DELETE FROM search_usage') {
      this.db.rows = [];
      return Promise.resolve({ results: [], success: true, meta: {} });
    }

    throw new Error(`Unsupported D1 run() query in search usage test: ${this.query}`);
  }
}

class FakeD1Database implements D1Database {
  rows: Array<{
    provider: string;
    key_id: string;
    hour: string;
    requests: number;
  }> = [];

  prepare(query: string): FakeD1PreparedStatement {
    return new FakeD1PreparedStatement(this, query);
  }

  upsert(query: string, binds: unknown[]): void {
    const [provider, keyId, hour, requests] = binds as [string, string, string, number];
    const existing = this.rows.find(r => r.provider === provider && r.key_id === keyId && r.hour === hour);
    if (existing) {
      existing.requests = query.includes('requests + excluded.requests') ? existing.requests + requests : requests;
    } else {
      this.rows.push({ provider, key_id: keyId, hour, requests });
    }
  }

  select(query: string, binds: unknown[]) {
    if (!query.includes('WHERE')) {
      return sortSearchUsageRecords(
        this.rows.map(r => ({
          provider: r.provider as SearchUsageRecord['provider'],
          keyId: r.key_id,
          hour: r.hour,
          requests: r.requests,
        })),
      ).map(r => ({
        provider: r.provider,
        key_id: r.keyId,
        hour: r.hour,
        requests: r.requests,
      }));
    }

    let provider: string | undefined;
    let start: string;
    let end: string;
    let keyId: string | undefined;
    if (query.includes('provider = ?') && query.includes('key_id = ?')) {
      [provider, start, end, keyId] = binds as [string, string, string, string];
    } else if (query.includes('provider = ?')) {
      [provider, start, end] = binds as [string, string, string];
    } else if (query.includes('key_id = ?')) {
      [start, end, keyId] = binds as [string, string, string];
    } else {
      [start, end] = binds as [string, string];
    }

    return this.rows
      .filter(r => !provider || r.provider === provider)
      .filter(r => !keyId || r.key_id === keyId)
      .filter(r => r.hour >= start && r.hour < end)
      .sort((a, b) => a.hour.localeCompare(b.hour));
  }
}

test('D1 search usage repo records, queries, overwrites, and clears', async () => {
  await exerciseSearchUsageRepo(new D1Repo(new FakeD1Database()).searchUsage);
});

test('D1 search usage repo rejects invalid provider names', async () => {
  await assertRejectsInvalidProvider(new D1Repo(new FakeD1Database()).searchUsage);
});

test('D1 search usage repo rejects invalid stored provider names', async () => {
  const db = new FakeD1Database();
  db.rows.push({
    provider: 'disabled',
    key_id: 'key_a',
    hour: '2026-04-25T10',
    requests: 1,
  });

  await assertRejects(() => new D1Repo(db).searchUsage.listAll(), TypeError, 'Invalid web search provider');
});
