import { test } from 'vitest';

import { doneFrame, eventFrame, jsonFrame, sseCommentFrame, sseFrame } from './types.ts';
import { assertEquals } from '../../../../test-assert.ts';

test('eventFrame carries structured protocol events', () => {
  assertEquals(eventFrame({ type: 'message_stop' }), {
    type: 'event',
    event: { type: 'message_stop' },
  });
});

test('doneFrame marks protocol sentinels without raw SSE text', () => {
  assertEquals(doneFrame(), { type: 'done' });
});

test('raw stream frame helpers keep upstream payload shape', () => {
  assertEquals(jsonFrame({ ok: true }), { type: 'json', data: { ok: true } });
  assertEquals(sseFrame('{}', 'message_stop'), {
    type: 'sse',
    event: 'message_stop',
    data: '{}',
  });
});

test('sseCommentFrame carries comment keepalive payloads', () => {
  assertEquals(sseCommentFrame('keepalive'), {
    type: 'sse-comment',
    comment: 'keepalive',
  });
});
