import { test } from 'vitest';

import { defaultsForProvider, getFlagCatalog, isKnownFlagId } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

test('provider flags: catalog ids are unique', () => {
  const ids = new Set<string>();
  for (const entry of getFlagCatalog()) {
    assertEquals(ids.has(entry.id), false);
    ids.add(entry.id);
  }
});

test('provider flags: every catalog entry has a non-empty label', () => {
  for (const entry of getFlagCatalog()) {
    assertEquals(typeof entry.label, 'string');
    assertEquals(entry.label.length > 0, true);
  }
});

test('provider flags: isKnownFlagId agrees with catalog', () => {
  for (const entry of getFlagCatalog()) {
    assertEquals(isKnownFlagId(entry.id), true);
  }
  assertEquals(isKnownFlagId('nonexistent-flag'), false);
});

const FLAG_ID_PATTERN = /^[a-z][a-z0-9-]+$/;

test('provider flags: every catalog id is kebab-case', () => {
  for (const entry of getFlagCatalog()) {
    assertEquals(FLAG_ID_PATTERN.test(entry.id), true, `id ${entry.id} must be kebab-case`);
  }
});

test('provider flags: every catalog entry has id, label, description string fields', () => {
  for (const entry of getFlagCatalog()) {
    assertEquals(typeof entry.id, 'string');
    assertEquals(entry.id.length > 0, true);
    assertEquals(typeof entry.label, 'string');
    assertEquals(typeof entry.description, 'string');
    assertEquals(entry.description.length > 0, true);
    assertEquals(Array.isArray(entry.defaultFor), true);
  }
});

test('provider flags: defaultsForProvider returns the catalog-declared defaults', () => {
  const copilotDefaults = [...defaultsForProvider('copilot')].sort();
  assertEquals(copilotDefaults, ['messages-web-search-shim', 'responses-image-generation-shim', 'retry-cyber-policy']);
  const azureDefaults = [...defaultsForProvider('azure')].sort();
  assertEquals(azureDefaults, ['messages-web-search-shim', 'responses-image-generation-shim']);
  assertEquals(defaultsForProvider('custom').size, 0);
});

test('provider flags: defaultsForProvider memoizes the set per provider kind', () => {
  // Azure's per-deployment getProvidedModels loop calls this once per
  // deployment per request; repeated calls must return the same frozen set
  // reference so the memo never regresses into per-call allocations.
  assertEquals(defaultsForProvider('copilot') === defaultsForProvider('copilot'), true);
  assertEquals(defaultsForProvider('azure') === defaultsForProvider('azure'), true);
  assertEquals(defaultsForProvider('custom') === defaultsForProvider('custom'), true);
});
