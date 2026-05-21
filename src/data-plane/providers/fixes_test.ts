import { test } from 'vitest';

import { getFixCatalog, isKnownFixId } from './fixes.ts';
import { assertEquals, assertExists } from '../../test-assert.ts';

const FIX_ID_PATTERN = /^[a-z][a-z0-9-]+$/;

test('provider fixes: every id is unique and well-formed', () => {
  const seen = new Set<string>();
  for (const entry of getFixCatalog()) {
    assertEquals(FIX_ID_PATTERN.test(entry.id), true, `Fix id "${entry.id}" violates ${FIX_ID_PATTERN.source}`);
    assertEquals(seen.has(entry.id), false, `duplicate fix id ${entry.id}`);
    seen.add(entry.id);
  }
});

test('provider fixes: appliesTo is non-empty and lists known endpoints only', () => {
  const known = new Set(['messages', 'responses', 'chat_completions']);
  for (const entry of getFixCatalog()) {
    assertEquals(entry.appliesTo.length > 0, true, `Fix ${entry.id} has empty appliesTo (would never be reachable)`);
    for (const endpoint of entry.appliesTo) {
      assertEquals(known.has(endpoint), true, `Fix ${entry.id} has unknown appliesTo endpoint ${endpoint}`);
    }
  }
});

test('provider fixes: isKnownFixId agrees with catalog', () => {
  for (const entry of getFixCatalog()) {
    assertEquals(isKnownFixId(entry.id), true);
  }
  assertEquals(isKnownFixId('nonexistent-fix'), false);
});

test('provider fixes: deepseek-reasoning-dialect is in catalog and chat_completions-scoped', () => {
  const entry = getFixCatalog().find(e => e.id === 'deepseek-reasoning-dialect');
  assertExists(entry);
  assertEquals(entry.appliesTo, ['chat_completions']);
});

test('provider fixes: messages-web-search-shim is messages-scoped', () => {
  const entry = getFixCatalog().find(e => e.id === 'messages-web-search-shim');
  assertExists(entry);
  assertEquals(entry.appliesTo, ['messages']);
});

test('provider fixes: vendor-style flags are present and span all LLM endpoints', () => {
  const vendorIds = ['vendor-deepseek', 'vendor-qwen'];
  for (const id of vendorIds) {
    const entry = getFixCatalog().find(e => e.id === id);
    assertExists(entry, `vendor flag ${id} missing from catalog`);
    assertEquals([...entry.appliesTo].sort(), ['chat_completions', 'messages', 'responses'], `vendor flag ${id} must apply to all LLM endpoints (so it can be enabled on any LLM upstream)`);
  }
});
