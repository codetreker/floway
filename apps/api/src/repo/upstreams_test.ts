import initSqlJs from 'sql.js';
import { test } from 'vitest';

import { assert, assertEquals, assertRejects } from '../test-assert.ts';
import { type D1Database, D1Repo } from './d1.ts';
import { InMemoryRepo } from './memory.ts';
import type { UpstreamRecord, UpstreamRepo } from './types.ts';

const upstream = (overrides: Partial<UpstreamRecord> & Pick<UpstreamRecord, 'id' | 'provider' | 'createdAt' | 'sortOrder'>): UpstreamRecord => ({
  name: overrides.id,
  enabled: true,
  updatedAt: overrides.createdAt,
  config: { nested: { value: overrides.id }, endpoints: ['chat_completions'] },
  flagOverrides: {},
  ...overrides,
});

test('memory upstream repo saves, lists, updates, deletes, and clears rows', async () => {
  const repo = new InMemoryRepo().upstreams;

  const custom = upstream({
    id: 'up_custom_a',
    provider: 'custom',
    name: 'Custom A',
    sortOrder: 2,
    createdAt: '2026-05-21T10:00:02.000Z',
    updatedAt: '2026-05-21T10:00:02.000Z',
  });
  const copilot = upstream({
    id: 'up_copilot_a',
    provider: 'copilot',
    name: 'Copilot A',
    sortOrder: 1,
    createdAt: '2026-05-21T10:00:03.000Z',
    updatedAt: '2026-05-21T10:00:03.000Z',
  });
  const azure = upstream({
    id: 'up_azure_a',
    provider: 'azure',
    name: 'Azure A',
    sortOrder: 1,
    createdAt: '2026-05-21T10:00:01.000Z',
    updatedAt: '2026-05-21T10:00:01.000Z',
  });

  await repo.save(custom);
  await repo.save(copilot);
  await repo.save(azure);

  assertEquals(
    (await repo.list()).map(row => row.id),
    ['up_azure_a', 'up_copilot_a', 'up_custom_a'],
  );

  assertEquals(await repo.getById('up_custom_a'), custom);
  assertEquals(await repo.getById('missing'), null);

  const updatedCustom = upstream({
    ...custom,
    name: 'Custom A Updated',
    enabled: false,
    sortOrder: 0,
    createdAt: '2099-01-01T00:00:00.000Z',
    updatedAt: '2026-05-21T10:00:04.000Z',
    config: { nested: { value: 'updated' }, supportedEndpoints: ['responses'] },
    flagOverrides: { 'retry-tool-use': true },
  });
  await repo.save(updatedCustom);

  assertEquals(
    (await repo.list()).map(row => [row.id, row.name, row.enabled]),
    [
      ['up_custom_a', 'Custom A Updated', false],
      ['up_azure_a', 'Azure A', true],
      ['up_copilot_a', 'Copilot A', true],
    ],
  );
  assertEquals((await repo.getById('up_custom_a'))?.createdAt, '2026-05-21T10:00:02.000Z');
  assertEquals(await repo.delete('up_azure_a'), true);
  assertEquals(await repo.delete('up_azure_a'), false);
  assertEquals(
    (await repo.list()).map(row => row.id),
    ['up_custom_a', 'up_copilot_a'],
  );

  await repo.deleteAll();
  assertEquals(await repo.list(), []);
});

test('memory upstream repo deeply clones configs and flag overrides at the repo boundary', async () => {
  const repo = new InMemoryRepo().upstreams;
  const original = upstream({
    id: 'up_custom_clone',
    provider: 'custom',
    sortOrder: 0,
    createdAt: '2026-05-21T10:00:00.000Z',
    config: {
      nested: {
        baseUrl: 'https://example.test/v1',
        headers: ['authorization'],
      },
    },
    flagOverrides: { 'z-fix': true, 'a-fix': true },
  });

  await repo.save(original);
  original.flagOverrides['mutated-after-save'] = true;
  (original.config as { nested: { headers: string[] } }).nested.headers.push('mutated-after-save');

  const saved = await repo.getById('up_custom_clone');
  assertEquals(saved?.flagOverrides, { 'a-fix': true, 'z-fix': true });
  assertEquals(saved?.config, {
    nested: {
      baseUrl: 'https://example.test/v1',
      headers: ['authorization'],
    },
  });

  const listed = await repo.list();
  listed[0].flagOverrides['mutated-after-list'] = true;
  (listed[0].config as { nested: { headers: string[] } }).nested.headers.push('mutated-after-list');

  assertEquals((await repo.getById('up_custom_clone'))?.flagOverrides, { 'a-fix': true, 'z-fix': true });
  assertEquals((await repo.getById('up_custom_clone'))?.config, {
    nested: {
      baseUrl: 'https://example.test/v1',
      headers: ['authorization'],
    },
  });
});

test('memory upstream repo sorts flag overrides by key when saving rows', async () => {
  const repo = new InMemoryRepo().upstreams;

  await repo.save(
    upstream({
      id: 'up_copilot_fixes',
      provider: 'copilot',
      sortOrder: 0,
      createdAt: '2026-05-21T10:00:00.000Z',
      flagOverrides: { 'z-fix': true, 'a-fix': false, 'm-fix': true },
    }),
  );

  assertEquals((await repo.getById('up_copilot_fixes'))?.flagOverrides, { 'a-fix': false, 'm-fix': true, 'z-fix': true });
});

const exerciseD1UpstreamRepo = async (repo: UpstreamRepo) => {
  const custom = upstream({
    id: 'up_custom_d1',
    provider: 'custom',
    name: 'Custom D1',
    sortOrder: 2,
    createdAt: '2026-05-21T10:00:02.000Z',
    updatedAt: '2026-05-21T10:00:02.000Z',
    config: { baseUrl: 'https://custom.example/v1', bearerToken: 'sk-custom', supportedEndpoints: ['chat_completions'] },
    flagOverrides: { 'z-fix': true, 'a-fix': true },
  });
  const copilot = upstream({
    id: 'up_copilot_d1',
    provider: 'copilot',
    name: 'Copilot D1',
    sortOrder: 1,
    createdAt: '2026-05-21T10:00:03.000Z',
    updatedAt: '2026-05-21T10:00:03.000Z',
    config: { githubToken: 'gho_d1', accountType: 'individual', user: { id: 1, login: 'copilot', name: null, avatar_url: 'https://avatars.test/1.png' } },
  });
  const azure = upstream({
    id: 'up_azure_d1',
    provider: 'azure',
    name: 'Azure D1',
    sortOrder: 1,
    createdAt: '2026-05-21T10:00:01.000Z',
    updatedAt: '2026-05-21T10:00:01.000Z',
    config: { endpoint: 'https://azure.example', apiKey: 'azure-key', deployments: [] },
  });

  await repo.save(custom);
  await repo.save(copilot);
  await repo.save(azure);

  assertEquals(
    (await repo.list()).map(row => row.id),
    ['up_azure_d1', 'up_copilot_d1', 'up_custom_d1'],
  );
  assertEquals((await repo.getById('up_custom_d1'))?.flagOverrides, { 'a-fix': true, 'z-fix': true });
  assertEquals(await repo.getById('missing'), null);

  await repo.save({
    ...custom,
    name: 'Custom D1 Updated',
    enabled: false,
    sortOrder: 0,
    createdAt: '2099-01-01T00:00:00.000Z',
    updatedAt: '2026-05-21T10:00:04.000Z',
    config: { baseUrl: 'https://updated.example/v1', bearerToken: 'sk-updated', supportedEndpoints: ['responses'] },
    flagOverrides: { 'm-fix': true, 'a-fix': true },
  });
  assertEquals(
    (await repo.list()).map(row => [row.id, row.name, row.enabled]),
    [
      ['up_custom_d1', 'Custom D1 Updated', false],
      ['up_azure_d1', 'Azure D1', true],
      ['up_copilot_d1', 'Copilot D1', true],
    ],
  );
  assertEquals((await repo.getById('up_custom_d1'))?.createdAt, '2026-05-21T10:00:02.000Z');

  assertEquals(await repo.delete('up_azure_d1'), true);
  assertEquals(await repo.delete('up_azure_d1'), false);
  assertEquals(
    (await repo.list()).map(row => row.id),
    ['up_custom_d1', 'up_copilot_d1'],
  );

  await repo.deleteAll();
  assertEquals(await repo.list(), []);
};

test('D1 upstream repo saves, lists, updates, deletes, and clears rows', async () => {
  await exerciseD1UpstreamRepo(new D1Repo(new FakeUpstreamsD1Database()).upstreams);
});

test('D1 upstream repo rejects malformed stored upstream JSON', async () => {
  const db = new FakeUpstreamsD1Database();
  db.rows.push({
    id: 'up_bad_config',
    provider: 'custom',
    name: 'Bad Config',
    enabled: 1,
    sort_order: 0,
    created_at: '2026-05-21T10:00:00.000Z',
    updated_at: '2026-05-21T10:00:00.000Z',
    config_json: '{bad json',
    flag_overrides: '{}',
  });

  await assertRejects(() => new D1Repo(db).upstreams.list(), Error, 'Malformed upstream config JSON for up_bad_config');
});

test('D1 upstream repo rejects malformed stored flag overrides JSON', async () => {
  const db = new FakeUpstreamsD1Database();
  db.rows.push({
    id: 'up_bad_fixes',
    provider: 'custom',
    name: 'Bad Fixes',
    enabled: 1,
    sort_order: 0,
    created_at: '2026-05-21T10:00:00.000Z',
    updated_at: '2026-05-21T10:00:00.000Z',
    config_json: '{}',
    flag_overrides: '{bad json',
  });

  await assertRejects(() => new D1Repo(db).upstreams.getById('up_bad_fixes'), Error, 'Malformed upstream flag_overrides JSON for up_bad_fixes');
});

test('D1 upstream repo rejects array-shaped flag_overrides with helpful message', async () => {
  const db = new FakeUpstreamsD1Database();
  db.rows.push({
    id: 'up_array_fixes',
    provider: 'custom',
    name: 'Array Fixes',
    enabled: 1,
    sort_order: 0,
    created_at: '2026-05-21T10:00:00.000Z',
    updated_at: '2026-05-21T10:00:00.000Z',
    config_json: '{}',
    flag_overrides: '[]',
  });

  await assertRejects(
    () => new D1Repo(db).upstreams.getById('up_array_fixes'),
    Error,
    'Upstream up_array_fixes flag_overrides must be a JSON object, got array',
  );
});

test('D1 upstream repo rejects non-boolean value in flag_overrides with helpful message', async () => {
  const db = new FakeUpstreamsD1Database();
  db.rows.push({
    id: 'up_nonbool_fixes',
    provider: 'custom',
    name: 'Non-boolean Fixes',
    enabled: 1,
    sort_order: 0,
    created_at: '2026-05-21T10:00:00.000Z',
    updated_at: '2026-05-21T10:00:00.000Z',
    config_json: '{}',
    flag_overrides: '{"x": 1}',
  });

  await assertRejects(
    () => new D1Repo(db).upstreams.getById('up_nonbool_fixes'),
    Error,
    'Upstream up_nonbool_fixes flag_overrides["x"] must be a boolean, got number',
  );
});

test('migration 0010 creates unified upstreams and rewrites legacy upstream identities', async () => {
  const db = await createMigratedSqlJsDatabase();
  try {
    seedLegacyUpstreamData(db);
    applySqlJsFile(db, '0010_unified_upstreams.sql');

    const copilotRows = sqlJsRows<{ id: string; sortOrder: number; userId: number; githubToken: string; accountType: string }>(
      db,
      `SELECT
        id,
        sort_order AS sortOrder,
        json_extract(config_json, '$.user.id') AS userId,
        json_extract(config_json, '$.githubToken') AS githubToken,
        json_extract(config_json, '$.accountType') AS accountType
       FROM upstreams
       WHERE provider = 'copilot'
       ORDER BY sort_order, userId`,
    );
    const customRows = sqlJsRows<{ id: string; sortOrder: number; baseUrl: string; bearerToken: string; firstEndpoint: string; chatPath: string }>(
      db,
      `SELECT
        id,
        sort_order AS sortOrder,
        json_extract(config_json, '$.baseUrl') AS baseUrl,
        json_extract(config_json, '$.bearerToken') AS bearerToken,
        json_extract(config_json, '$.supportedEndpoints[0]') AS firstEndpoint,
        json_extract(config_json, '$.pathOverrides.chat_completions') AS chatPath
       FROM upstreams
       WHERE provider = 'custom'`,
    );

    assertEquals(
      copilotRows.map(row => row.userId),
      [2, 1],
    );
    assert(copilotRows.every(row => /^up_[0-9a-f]{24}$/.test(row.id) && !row.id.includes('copilot')));
    assertEquals(copilotRows.map(row => row.githubToken), ['gho_two', 'gho_one']);
    assertEquals(copilotRows.map(row => row.accountType), ['business', 'individual']);

    assertEquals(customRows, [
      {
        id: 'up_custom_existing',
        sortOrder: customRows[0].sortOrder,
        baseUrl: 'https://custom.example/v1',
        bearerToken: 'sk-custom',
        firstEndpoint: '/chat/completions',
        chatPath: '/chat/completions',
      },
    ]);
    assert(customRows[0].sortOrder > copilotRows[1].sortOrder);

    const userTwoUpstreamId = copilotRows.find(row => row.userId === 2)?.id;
    const userOneUpstreamId = copilotRows.find(row => row.userId === 1)?.id;
    assert(userTwoUpstreamId);
    assert(userOneUpstreamId);

    assertEquals(sqlJsRows<{ hour: string; upstream: string | null }>(db, 'SELECT hour, upstream FROM usage ORDER BY hour'), [
      { hour: '2026-05-21T00', upstream: 'up_custom_existing' },
      { hour: '2026-05-21T01', upstream: userTwoUpstreamId },
      { hour: '2026-05-21T02', upstream: null },
      { hour: '2026-05-21T03', upstream: null },
      { hour: '2026-05-21T04', upstream: null },
    ]);
    assertEquals(sqlJsRows<{ requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }>(
      db,
      `SELECT
        requests,
        input_tokens AS inputTokens,
        output_tokens AS outputTokens,
        cache_read_tokens AS cacheReadTokens,
        cache_creation_tokens AS cacheCreationTokens
       FROM usage
       WHERE hour = '2026-05-21T04'`,
    ), [
      { requests: 5, inputTokens: 60, outputTokens: 80, cacheReadTokens: 10, cacheCreationTokens: 12 },
    ]);
    assertEquals(sqlJsRows<{ hour: string; upstream: string | null; requests: number; errors: number; totalMsSum: number }>(
      db,
      `SELECT
        hour,
        upstream,
        requests,
        errors,
        total_ms_sum AS totalMsSum
       FROM performance_summary
       ORDER BY hour`,
    ), [
      { hour: '2026-05-21T00', upstream: userOneUpstreamId, requests: 1, errors: 0, totalMsSum: 100 },
      { hour: '2026-05-21T02', upstream: null, requests: 5, errors: 3, totalMsSum: 500 },
    ]);
    assertEquals(sqlJsRows<{ hour: string; upstream: string | null; count: number }>(db, 'SELECT hour, upstream, count FROM performance_latency_buckets ORDER BY hour'), [
      { hour: '2026-05-21T00', upstream: 'up_custom_existing', count: 1 },
      { hour: '2026-05-21T01', upstream: null, count: 3 },
    ]);
    assertEquals(sqlJsRows<{ key: string }>(db, 'SELECT key FROM config ORDER BY key'), [{ key: 'keep_me' }]);
    assertEquals(sqlJsRows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('github_accounts', 'upstream_configs') ORDER BY name"), []);
  } finally {
    db.close();
  }
});

type FakeUpstreamRow = {
  id: string;
  provider: string;
  name: string;
  enabled: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  config_json: string;
  flag_overrides: string;
};

class FakeUpstreamsD1PreparedStatement {
  private binds: unknown[] = [];

  constructor(private db: FakeUpstreamsD1Database, private query: string) {}

  bind(...values: unknown[]): FakeUpstreamsD1PreparedStatement {
    this.binds = values;
    return this;
  }

  first<T>(): Promise<T | null> {
    if (this.query.includes('FROM upstreams WHERE id = ?')) {
      return Promise.resolve((this.db.selectById(this.binds[0] as string) as T | undefined) ?? null);
    }

    throw new Error(`Unsupported D1 first() query in upstreams test: ${this.query}`);
  }

  all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    if (this.query.includes('FROM upstreams')) {
      return Promise.resolve({
        results: this.db.selectAll() as T[],
        success: true,
        meta: {},
      });
    }

    throw new Error(`Unsupported D1 all() query in upstreams test: ${this.query}`);
  }

  run(): Promise<{ results: never[]; success: true; meta: Record<string, unknown> }> {
    if (this.query.startsWith('INSERT INTO upstreams')) {
      this.db.upsert(this.binds);
      return Promise.resolve({ results: [], success: true, meta: { changes: 1 } });
    }
    if (this.query === 'DELETE FROM upstreams') {
      this.db.rows = [];
      return Promise.resolve({ results: [], success: true, meta: { changes: 0 } });
    }
    if (this.query.startsWith('DELETE FROM upstreams WHERE id = ?')) {
      const deleted = this.db.deleteById(this.binds[0] as string);
      return Promise.resolve({ results: [], success: true, meta: { changes: deleted ? 1 : 0 } });
    }

    throw new Error(`Unsupported D1 run() query in upstreams test: ${this.query}`);
  }
}

class FakeUpstreamsD1Database implements D1Database {
  rows: FakeUpstreamRow[] = [];

  prepare(query: string): FakeUpstreamsD1PreparedStatement {
    return new FakeUpstreamsD1PreparedStatement(this, query);
  }

  selectAll(): FakeUpstreamRow[] {
    return this.rows.map(cloneFakeUpstreamRow).toSorted(compareFakeUpstreamRows);
  }

  selectById(id: string): FakeUpstreamRow | undefined {
    const row = this.rows.find(candidate => candidate.id === id);
    return row ? cloneFakeUpstreamRow(row) : undefined;
  }

  upsert(binds: unknown[]): void {
    const [id, provider, name, enabled, sortOrder, createdAt, updatedAt, configJson, flagOverrides] = binds as [string, string, string, number, number, string, string, string, string];
    const existingIndex = this.rows.findIndex(candidate => candidate.id === id);
    const preservedCreatedAt = existingIndex >= 0 ? this.rows[existingIndex].created_at : createdAt;
    const row = {
      id,
      provider,
      name,
      enabled,
      sort_order: sortOrder,
      created_at: preservedCreatedAt,
      updated_at: updatedAt,
      config_json: configJson,
      flag_overrides: flagOverrides,
    };
    if (existingIndex >= 0) {
      this.rows[existingIndex] = row;
      return;
    }
    this.rows.push(row);
  }

  deleteById(id: string): boolean {
    const previousLength = this.rows.length;
    this.rows = this.rows.filter(row => row.id !== id);
    return this.rows.length !== previousLength;
  }
}

const cloneFakeUpstreamRow = (row: FakeUpstreamRow): FakeUpstreamRow => ({ ...row });

const compareFakeUpstreamRows = (a: FakeUpstreamRow, b: FakeUpstreamRow): number => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at);

type SqlJsDatabase = {
  run(sql: string): void;
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  close(): void;
};

const migrationSqlByPath = import.meta.glob('../../migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const migrationSqlByFilename = new Map(
  Object.entries(migrationSqlByPath).map(([path, sql]) => [path.slice(path.lastIndexOf('/') + 1), sql]),
);

const createMigratedSqlJsDatabase = async (): Promise<SqlJsDatabase> => {
  const SQL = await initSqlJs();
  const db = new SQL.Database() as SqlJsDatabase;
  for (const filename of [...migrationSqlByFilename.keys()].filter(filename => filename < '0010_unified_upstreams.sql').toSorted()) {
    applySqlJsFile(db, filename);
  }
  return db;
};

const applySqlJsFile = (db: SqlJsDatabase, filename: string): void => {
  const sql = migrationSqlByFilename.get(filename);
  if (!sql) throw new Error(`Missing migration SQL fixture: ${filename}`);
  db.run(sql);
};

const sqlJsRows = <T>(db: SqlJsDatabase, sql: string): T[] => {
  const [result] = db.exec(sql);
  if (!result) return [];
  return result.values.map(values => Object.fromEntries(result.columns.map((column, index) => [column, values[index] ?? null])) as T);
};

const seedLegacyUpstreamData = (db: SqlJsDatabase): void => {
  db.run(
    `INSERT INTO github_accounts (user_id, token, login, name, avatar_url, account_type)
     VALUES
       (1, 'gho_one', 'one', 'One User', 'https://avatars.example/one.png', 'individual'),
       (2, 'gho_two', 'two', NULL, 'https://avatars.example/two.png', 'business');

     INSERT INTO config (key, value)
     VALUES
       ('github_account_order', '[999,2]'),
       ('models_cache_v2:stale', 'stale'),
       ('keep_me', 'ok');

     INSERT INTO upstream_configs (id, name, base_url, bearer_token, supported_endpoints, enabled, sort_order, created_at, enabled_fixes, path_overrides)
     VALUES (
       'up_custom_existing',
       'Existing Custom',
       'https://custom.example/v1',
       'sk-custom',
       '["/chat/completions"]',
       1,
       0,
       '2026-05-21T00:00:00.000Z',
       '["z-fix","a-fix"]',
       '{"chat_completions":"/chat/completions"}'
     );

     INSERT INTO usage (key_id, model, upstream, model_key, hour, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
     VALUES
       ('key', 'gpt-5.4', 'openai:up_custom_existing', 'gpt-5.4', '2026-05-21T00', 1, 2, 3, 0, 0),
       ('key', 'gpt-5.4', 'copilot:2', 'gpt-5.4', '2026-05-21T01', 1, 2, 3, 0, 0),
       ('key', 'gpt-5.4', NULL, 'gpt-5.4', '2026-05-21T02', 1, 2, 3, 0, 0),
       ('key', 'gpt-5.4', 'copilot:999', 'gpt-5.4', '2026-05-21T03', 1, 2, 3, 0, 0),
       ('key', 'gpt-5.4', 'copilot:998', 'gpt-5.4', '2026-05-21T04', 2, 20, 30, 4, 5),
       ('key', 'gpt-5.4', 'copilot:999', 'gpt-5.4', '2026-05-21T04', 3, 40, 50, 6, 7);

     INSERT INTO performance_summary (hour, metric_scope, key_id, model, upstream, model_key, source_api, target_api, stream, runtime_location, requests, errors, total_ms_sum)
     VALUES
       ('2026-05-21T00', 'request_total', 'key', 'gpt-5.4', 'copilot:1', 'gpt-5.4', 'messages', 'responses', 1, 'unknown', 1, 0, 100),
       ('2026-05-21T02', 'request_total', 'key', 'gpt-5.4', 'copilot:998', 'gpt-5.4', 'messages', 'responses', 1, 'unknown', 2, 1, 200),
       ('2026-05-21T02', 'request_total', 'key', 'gpt-5.4', 'copilot:999', 'gpt-5.4', 'messages', 'responses', 1, 'unknown', 3, 2, 300);

     INSERT INTO performance_latency_buckets (hour, metric_scope, key_id, model, upstream, model_key, source_api, target_api, stream, runtime_location, lower_ms, upper_ms, count)
     VALUES
       ('2026-05-21T00', 'request_total', 'key', 'gpt-5.4', 'openai:up_custom_existing', 'gpt-5.4', 'messages', 'responses', 1, 'unknown', 0, 142, 1),
       ('2026-05-21T01', 'request_total', 'key', 'gpt-5.4', 'copilot:998', 'gpt-5.4', 'messages', 'responses', 1, 'unknown', 0, 142, 2),
       ('2026-05-21T01', 'request_total', 'key', 'gpt-5.4', 'copilot:999', 'gpt-5.4', 'messages', 'responses', 1, 'unknown', 0, 142, 1);`,
  );
};
