import { test } from 'vitest';

import { resolveEffectiveFlags } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

test('flags-resolve: empty defaults and no layers → empty set', () => {
  const set = resolveEffectiveFlags(new Set(), []);
  assertEquals([...set].sort(), []);
});

test('flags-resolve: provider defaults are always present', () => {
  const set = resolveEffectiveFlags(new Set(['retry-cyber-policy']), []);
  assertEquals([...set].sort(), ['retry-cyber-policy']);
});

test('flags-resolve: defaults can be force-off by any layer', () => {
  const set = resolveEffectiveFlags(
    new Set(['retry-cyber-policy']),
    [{ 'retry-cyber-policy': false }],
  );
  assertEquals([...set].sort(), []);
});

test('flags-resolve: a later layer force-on re-adds a default an earlier layer removed', () => {
  const set = resolveEffectiveFlags(
    new Set(['retry-cyber-policy']),
    [{ 'retry-cyber-policy': false }, { 'retry-cyber-policy': true }],
  );
  assertEquals([...set].sort(), ['retry-cyber-policy']);
});

test('flags-resolve: upstream layer force-on adds a non-default flag', () => {
  const set = resolveEffectiveFlags(new Set(), [{ 'vendor-deepseek': true }]);
  assertEquals([...set].sort(), ['vendor-deepseek']);
});

test('flags-resolve: deployment layer can force-off a non-default flag enabled upstream', () => {
  const set = resolveEffectiveFlags(
    new Set(),
    [{ 'vendor-deepseek': true }, { 'vendor-deepseek': false }],
  );
  assertEquals([...set].sort(), []);
});

test('flags-resolve: deployment layer wins over upstream when both set the same flag', () => {
  const set = resolveEffectiveFlags(
    new Set(),
    [{ 'vendor-qwen': false }, { 'vendor-qwen': true }],
  );
  assertEquals([...set].sort(), ['vendor-qwen']);
});

test('flags-resolve: undefined layers are skipped', () => {
  const set = resolveEffectiveFlags(new Set(['retry-cyber-policy']), [undefined, undefined]);
  assertEquals([...set].sort(), ['retry-cyber-policy']);
});
