import { test } from 'vitest';

import { packReasoningSignature, unpackReasoningSignature } from './messages-responses-signature.ts';
import { assertEquals } from '../../../../test-assert.ts';

test('packReasoningSignature joins encrypted_content and id with @', () => {
  assertEquals(packReasoningSignature('rs_42', 'enc_abc'), 'enc_abc@rs_42');
});

test('unpackReasoningSignature recovers id and encrypted_content from packed form', () => {
  assertEquals(unpackReasoningSignature('enc_abc@rs_42'), { id: 'rs_42', encryptedContent: 'enc_abc' });
});

test('unpackReasoningSignature is the inverse of packReasoningSignature', () => {
  const original = { id: 'rs_99', encryptedContent: 'base64-blob' };
  const packed = packReasoningSignature(original.id, original.encryptedContent);
  assertEquals(unpackReasoningSignature(packed), original);
});

test('unpackReasoningSignature returns null id for unpacked signatures', () => {
  assertEquals(unpackReasoningSignature('opaque-blob-with-no-at-sign'), { id: null, encryptedContent: 'opaque-blob-with-no-at-sign' });
});

test('unpackReasoningSignature returns null id when @ is at the start', () => {
  assertEquals(unpackReasoningSignature('@rs_1'), { id: null, encryptedContent: '@rs_1' });
});

test('unpackReasoningSignature returns null id when @ is at the end', () => {
  assertEquals(unpackReasoningSignature('enc_abc@'), { id: null, encryptedContent: 'enc_abc@' });
});

test('unpackReasoningSignature splits on the LAST @ so embedded @ in the blob is preserved', () => {
  // base64 encrypted_content shouldn't contain @, but if upstream ever widens
  // the alphabet, lastIndexOf still picks the trailing id correctly.
  assertEquals(unpackReasoningSignature('enc@with@inside@rs_7'), { id: 'rs_7', encryptedContent: 'enc@with@inside' });
});

test('unpackReasoningSignature handles an empty input', () => {
  assertEquals(unpackReasoningSignature(''), { id: null, encryptedContent: '' });
});
