import { test } from 'vitest';

import { emptyLedger, mergeLedger, projectLedger, type CopilotLedger } from './ledger.ts';
import type { CopilotModelsResponse, CopilotRawModel } from './types.ts';
import { assertEquals } from '../../../test-assert.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const model = (id: string): CopilotRawModel => ({ id, name: id, version: '1' });
const response = (...ids: string[]): CopilotModelsResponse => ({ object: 'list', data: ids.map(model) });

test('emptyLedger returns a ledger with no models and fetchedAt 0', () => {
  const ledger = emptyLedger();
  assertEquals(ledger.fetchedAt, 0);
  assertEquals(Object.keys(ledger.models).length, 0);
});

test('mergeLedger seeds an empty ledger with every model in the response', () => {
  const merged = mergeLedger(emptyLedger(), response('a', 'b'), 1_000_000);
  assertEquals(merged.fetchedAt, 1_000_000);
  assertEquals(Object.keys(merged.models).sort(), ['a', 'b']);
  assertEquals(merged.models.a.lastSeenAt, 1_000_000);
});

test('mergeLedger preserves previously-seen models that are missing this fetch', () => {
  const prev: CopilotLedger = {
    fetchedAt: 1_000_000,
    models: {
      a: { snapshot: model('a'), lastSeenAt: 1_000_000 },
      b: { snapshot: model('b'), lastSeenAt: 1_000_000 },
    },
  };
  const merged = mergeLedger(prev, response('a'), 1_000_000 + HOUR);
  assertEquals(Object.keys(merged.models).sort(), ['a', 'b']);
  assertEquals(merged.models.a.lastSeenAt, 1_000_000 + HOUR);
  assertEquals(merged.models.b.lastSeenAt, 1_000_000, 'missing model keeps its old lastSeenAt');
});

test('mergeLedger drops models whose lastSeenAt is older than 24 h', () => {
  const prev: CopilotLedger = {
    fetchedAt: 1_000_000,
    models: {
      stale: { snapshot: model('stale'), lastSeenAt: 1_000_000 },
      fresh: { snapshot: model('fresh'), lastSeenAt: 1_000_000 + HOUR },
    },
  };
  const merged = mergeLedger(prev, response(), 1_000_000 + DAY + 1);
  assertEquals(Object.keys(merged.models).sort(), ['fresh']);
});

test('mergeLedger refreshes snapshot data when the model reappears', () => {
  const prev: CopilotLedger = {
    fetchedAt: 1_000_000,
    models: { a: { snapshot: { ...model('a'), name: 'old' }, lastSeenAt: 1_000_000 } },
  };
  const response: CopilotModelsResponse = {
    object: 'list',
    data: [{ ...model('a'), name: 'new' }],
  };
  const merged = mergeLedger(prev, response, 1_000_000 + HOUR);
  assertEquals(merged.models.a.snapshot.name, 'new');
});

test('projectLedger returns only entries within the 24 h window', () => {
  const ledger: CopilotLedger = {
    fetchedAt: 1_000_000,
    models: {
      stale: { snapshot: model('stale'), lastSeenAt: 1_000_000 },
      fresh: { snapshot: model('fresh'), lastSeenAt: 1_000_000 + HOUR },
    },
  };
  const projected = projectLedger(ledger, 1_000_000 + DAY + 1);
  assertEquals(projected.length, 1);
  assertEquals(projected[0].id, 'fresh');
});
