import { test } from 'vitest';

import { type LlmServeFailure, throwLlmServeFailure, tryCatchLlmServeFailure } from './errors.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const cases: readonly LlmServeFailure[] = [
  { kind: 'model-missing', model: 'gpt-9' },
  { kind: 'model-unsupported', model: 'gpt-9' },
  { kind: 'item-not-found', itemId: 'msg_abc' },
  { kind: 'routing-unavailable', message: 'no upstream can serve this' },
];

for (const failure of cases) {
  test(`round-trips ${failure.kind} through throw/catch`, () => {
    const error = assertThrows(() => throwLlmServeFailure(failure));
    assertEquals(tryCatchLlmServeFailure(error), failure);
  });
}

test('returns null for an error not raised by throwLlmServeFailure', () => {
  assertEquals(tryCatchLlmServeFailure(new Error('something else')), null);
  assertEquals(tryCatchLlmServeFailure('not even an error'), null);
  assertEquals(tryCatchLlmServeFailure(null), null);
});
