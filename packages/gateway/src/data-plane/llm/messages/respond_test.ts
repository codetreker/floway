import { test } from 'vitest';

import { createMessagesStreamUsageState, tokenUsageFromMessagesFrame } from './respond.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { assertEquals } from '@floway-dev/test-utils';

const stop = () => eventFrame({ type: 'message_stop' } satisfies MessagesStreamEvent);

test('Messages stream usage keeps start input and delta output', () => {
  const state = createMessagesStreamUsageState();

  assertEquals(
    tokenUsageFromMessagesFrame(
      eventFrame({
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 12,
            output_tokens: 1,
            cache_creation_input_tokens: 4,
            cache_read_input_tokens: 3,
          },
        },
      } satisfies MessagesStreamEvent),
      state,
    ),
    null,
  );
  assertEquals(
    tokenUsageFromMessagesFrame(
      eventFrame({
        type: 'message_delta',
        delta: {},
        usage: { output_tokens: 7 },
      } satisfies MessagesStreamEvent),
      state,
    ),
    null,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input: 12,
    input_cache_read: 3,
    input_cache_write: 4,
    output: 7,
  });
});

test('Messages stream usage can recover input from delta', () => {
  const state = createMessagesStreamUsageState();

  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    } satisfies MessagesStreamEvent),
    state,
  );
  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_delta',
      delta: {},
      usage: {
        input_tokens: 11,
        output_tokens: 2,
        cache_creation_input_tokens: 7,
        cache_read_input_tokens: 5,
      },
    } satisfies MessagesStreamEvent),
    state,
  );
  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_delta',
      delta: {},
      usage: { output_tokens: 6 },
    } satisfies MessagesStreamEvent),
    state,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input: 11,
    input_cache_read: 5,
    input_cache_write: 7,
    output: 6,
  });
});

test('Messages stream usage keeps cache-only start when a later delta carries input', () => {
  // A fully cache-hit prompt: message_start reports bare input 0 but non-zero
  // cache reads. A subsequent delta carries input_tokens, which must not cause
  // the start's cache counts to be dropped.
  const state = createMessagesStreamUsageState();

  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 1000 },
      },
    } satisfies MessagesStreamEvent),
    state,
  );
  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_delta',
      delta: {},
      usage: { input_tokens: 0, output_tokens: 50 },
    } satisfies MessagesStreamEvent),
    state,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input_cache_read: 1000,
    output: 50,
  });
});
