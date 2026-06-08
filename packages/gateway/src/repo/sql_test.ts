import initSqlJs from 'sql.js';
import { test } from 'vitest';

import { SqlRepo } from './sql.ts';
import type { SqlDatabase, SqlPreparedStatement, SqlResult } from '@floway-dev/platform';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const goodAccount = { chatgptAccountId: 'aid', refresh_token: 'rt_v1', state: 'active' as const, state_updated_at: '2026-01-01T00:00:00Z' };
const baseRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_test',
  provider: 'codex',
  name: 'Codex Test',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-05T00:00:00.000Z',
  updatedAt: '2026-06-05T00:00:00.000Z',
  config: { accounts: [{ email: 'a@b.com', chatgptAccountId: 'aid', chatgptUserId: 'uid', planType: 'plus' }] },
  state: { accounts: [goodAccount] },
  flagOverrides: {},
  disabledPublicModelIds: [],
  ...overrides,
});

test('SQL upstream repo round-trips state_json on save/list/getById', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  const original = baseRecord();
  await repo.save(original);
  assertEquals((await repo.getById('up_test'))?.state, { accounts: [goodAccount] });
  assertEquals((await repo.list())[0].state, { accounts: [goodAccount] });
});

test('SQL upstream repo saveState writes when expectedState matches', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await repo.save(baseRecord());
  const nextAccount = { ...goodAccount, refresh_token: 'rt_v2' };
  const result = await repo.saveState(
    'up_test',
    { accounts: [nextAccount] },
    { expectedState: { accounts: [goodAccount] } },
  );
  assertEquals(result.updated, true);
  assertEquals((await repo.getById('up_test'))?.state, { accounts: [nextAccount] });
});

test('SQL upstream repo saveState refuses when expectedState diverges (operator re-import race)', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await repo.save(baseRecord());
  const operatorAccount = { ...goodAccount, refresh_token: 'rt_operator_new' };
  // Simulate operator re-import that replaced the credential out-of-band.
  await repo.save(baseRecord({ state: { accounts: [operatorAccount] } }));
  const result = await repo.saveState(
    'up_test',
    { accounts: [{ ...goodAccount, refresh_token: 'rt_v2' }] },
    { expectedState: { accounts: [goodAccount] } },
  );
  assertEquals(result.updated, false);
  assertEquals((await repo.getById('up_test'))?.state, { accounts: [operatorAccount] });
});

test('SQL upstream repo saveState round-trip uses canonical JSON form (back-to-back CAS works)', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await repo.save(baseRecord());
  const v2Account = { state: 'active' as const, refresh_token: 'rt_v2', chatgptAccountId: 'aid', state_updated_at: '2026-01-02T00:00:00Z' }; // intentionally re-ordered keys
  // First CAS: prior state shape from save() must match.
  const first = await repo.saveState(
    'up_test',
    { accounts: [v2Account] },
    { expectedState: { accounts: [goodAccount] } },
  );
  assertEquals(first.updated, true);
  // Second CAS: the previously-written shape must serialize identically when
  // passed back as expectedState (regardless of input key order).
  const second = await repo.saveState(
    'up_test',
    { accounts: [{ ...v2Account, refresh_token: 'rt_v3' }] },
    { expectedState: { accounts: [v2Account] } },
  );
  assertEquals(second.updated, true);
});

// sql.js gives us real SQLite semantics in-process (including `IS NULL`
// comparison required for the CAS predicate). We adapt it to SqlDatabase so
// the same SqlRepo runs end-to-end against the same SQL the production
// platforms execute.
const migrationSqlByPath = import.meta.glob('../../migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const migrationSqlByFilename = [...Object.entries(migrationSqlByPath)]
  .map(([path, sql]) => [path.slice(path.lastIndexOf('/') + 1), sql] as const)
  .toSorted(([a], [b]) => a.localeCompare(b));

type SqlJsDatabase = {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  close(): void;
};

const createSqliteTestDb = async (): Promise<SqlDatabase> => {
  const SQL = await initSqlJs();
  const db = new SQL.Database() as SqlJsDatabase;
  for (const [, sql] of migrationSqlByFilename) db.run(sql);
  return new SqlJsSqlDatabase(db);
};

class SqlJsPreparedStatement implements SqlPreparedStatement {
  constructor(private readonly db: SqlJsDatabase, private readonly query: string, private readonly bound: readonly unknown[] = []) {}

  bind(...values: unknown[]): SqlPreparedStatement {
    return new SqlJsPreparedStatement(this.db, this.query, values);
  }

  first<T = Record<string, unknown>>(): Promise<T | null> {
    const [result] = this.db.exec(this.query, this.bound as unknown[]);
    if (!result || result.values.length === 0) return Promise.resolve(null);
    const row = Object.fromEntries(result.columns.map((column, index) => [column, result.values[0][index] ?? null])) as T;
    return Promise.resolve(row);
  }

  all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    const [result] = this.db.exec(this.query, this.bound as unknown[]);
    if (!result) return Promise.resolve({ results: [], success: true, meta: {} });
    const results = result.values.map(values => Object.fromEntries(result.columns.map((column, index) => [column, values[index] ?? null])) as T);
    return Promise.resolve({ results, success: true, meta: {} });
  }

  run(): Promise<SqlResult> {
    // sql.js's `run()` does not surface `changes`. Use a small wrapper around
    // exec() of `changes()` to read it back instead, since the CAS path in
    // saveState relies on this being accurate.
    this.db.run(this.query, this.bound as unknown[]);
    const [changesResult] = this.db.exec('SELECT changes() AS changes');
    const changes = Number(changesResult?.values[0]?.[0] ?? 0);
    return Promise.resolve({ results: [], success: true, meta: { changes } });
  }
}

class SqlJsSqlDatabase implements SqlDatabase {
  constructor(private readonly db: SqlJsDatabase) {}

  prepare(query: string): SqlPreparedStatement {
    return new SqlJsPreparedStatement(this.db, query);
  }

  exec(sql: string): Promise<unknown> {
    this.db.exec(sql);
    return Promise.resolve(undefined);
  }
}
