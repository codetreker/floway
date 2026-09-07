import { expect, test } from 'vitest';

import { createSqlJsDatabase, migrationSqlByFilename } from '../repo/test-sqlite.ts';

const migration = migrationSqlByFilename.find(([filename]) => filename === '0084_m365_copilot_web_provider.sql');
if (migration === undefined) throw new Error('0084 M365 provider migration is missing');

const insertM365 = (
  run: (sql: string) => void,
  id: string,
  tenantId: string,
  objectId: string,
  provider = 'm365-copilot-web',
): void => run(
  `INSERT INTO upstreams (
    id, provider, name, enabled, sort_order, created_at, updated_at,
    config_json, state_json, flag_overrides, disabled_public_model_ids,
    proxy_fallback_list_json, model_prefix_json, models_cache_json, hue
  ) VALUES (
    '${id}', '${provider}', '${id}', 1, 0, '2026-01-01', '2026-01-01',
    '${JSON.stringify({ account: { tenantId, objectId } })}', NULL, '{}', '[]', '[]', NULL, NULL, 210
  )`,
);

test('0084 preserves upstream rows and uniquely indexes the canonical M365 account identity', async () => {
  const db = await createSqlJsDatabase();
  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === migration[0]) break;
    db.run(sql);
  }
  db.run(
    `INSERT INTO upstreams (
      id, provider, name, enabled, sort_order, created_at, updated_at,
      config_json, state_json, flag_overrides, disabled_public_model_ids,
      proxy_fallback_list_json, model_prefix_json, models_cache_json, hue
    ) VALUES ('existing', 'custom', 'Existing', 1, 0, '2026-01-01', '2026-01-02', '{}', '{"live":true}', '{}', '[]', '[]', NULL, NULL, 123)`,
  );
  db.run(
    `INSERT INTO upstreams (
      id, provider, name, enabled, sort_order, created_at, updated_at,
      config_json, state_json, flag_overrides, disabled_public_model_ids,
      proxy_fallback_list_json, model_prefix_json, models_cache_json, hue
    ) VALUES ('malformed-custom', 'custom', 'Malformed', 1, 1, '2026-01-01', '2026-01-02', '{bad', NULL, '{}', '[]', '[]', NULL, NULL, 124)`,
  );
  db.run(migration[1]);

  expect(db.exec("SELECT provider, name, state_json, hue FROM upstreams WHERE id = 'existing'")[0]?.values)
    .toEqual([['custom', 'Existing', '{"live":true}', 123]]);
  expect(db.exec("SELECT config_json FROM upstreams WHERE id = 'malformed-custom'")[0]?.values)
    .toEqual([['{bad']]);
  expect(db.exec("PRAGMA index_list('upstreams')")[0]?.values)
    .toContainEqual(expect.arrayContaining(['idx_upstreams_m365_account', 1, 'c', 1]));
  const expressionColumns = db.exec("PRAGMA index_xinfo('idx_upstreams_m365_account')")[0]?.values
    .filter(row => row[5] === 1 && row[1] === -2);
  expect(expressionColumns).toHaveLength(2);
  insertM365(sql => db.run(sql), 'm365-a', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
  expect(() => insertM365(
    sql => db.run(sql),
    'm365-duplicate-case',
    '11111111-1111-4111-8111-111111111111'.toUpperCase(),
    '22222222-2222-4222-8222-222222222222'.toUpperCase(),
  )).toThrow(/UNIQUE constraint failed/);
  expect(() => insertM365(
    sql => db.run(sql),
    'm365-other-object',
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333',
  )).not.toThrow();
  expect(() => insertM365(
    sql => db.run(sql),
    'm365-other-tenant',
    '44444444-4444-4444-8444-444444444444',
    '22222222-2222-4222-8222-222222222222',
  )).not.toThrow();
  const duplicateConfig = JSON.stringify({
    account: {
      tenantId: '11111111-1111-4111-8111-111111111111',
      objectId: '22222222-2222-4222-8222-222222222222',
    },
  });
  expect(() => db.run(
    `UPDATE upstreams
     SET config_json = '${duplicateConfig}'
     WHERE id = 'm365-other-object'`,
  )).toThrow(/UNIQUE constraint failed/);
  expect(() => insertM365(
    sql => db.run(sql),
    'custom-same-account',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'custom',
  )).not.toThrow();
});
