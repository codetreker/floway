import { test } from 'vitest';

import { createResponsesToMessagesStreamState, translateResponsesStreamEventToMessagesEvents } from './events.ts';
import { assertEquals, assertFalse } from '../../../../test-assert.ts';

test('opaque-only Responses reasoning stream becomes redacted_thinking with packed id', () => {
  const state = createResponsesToMessagesStreamState();

  const events = translateResponsesStreamEventToMessagesEvents(
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'rs_0',
        summary: [],
        encrypted_content: 'opaque_sig',
      },
    },
    state,
  );

  assertEquals(events, [
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'redacted_thinking',
        data: 'opaque_sig@rs_0',
      },
    },
  ]);
});

test('text-only Responses reasoning stream omits signature deltas', () => {
  const state = createResponsesToMessagesStreamState();

  const events = [
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_0',
        output_index: 0,
        summary_index: 0,
        delta: 'trace',
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_0',
          summary: [{ type: 'summary_text', text: 'trace' }],
        },
      },
      state,
    ),
  ];

  assertEquals(events, [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'trace' },
    },
  ]);
  assertFalse(events.some(event => event.type === 'content_block_delta' && event.delta.type === 'signature_delta'));
});

test('Responses reasoning stream packs id into signature when done summary is empty after text delta', () => {
  const state = createResponsesToMessagesStreamState();

  const events = [
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_0',
        output_index: 0,
        summary_index: 0,
        delta: 'trace',
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_0',
          summary: [],
          encrypted_content: 'sig',
        },
      },
      state,
    ),
  ];

  assertEquals(events, [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'trace' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig@rs_0' },
    },
  ]);
});

test('done-only Responses reasoning summary stream emits thinking text once', () => {
  const state = createResponsesToMessagesStreamState();

  const events = [
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.reasoning_summary_text.done',
        item_id: 'rs_0',
        output_index: 0,
        summary_index: 0,
        text: 'trace',
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_0',
          summary: [{ type: 'summary_text', text: 'trace' }],
        },
      },
      state,
    ),
  ];

  assertEquals(
    events.filter(event => event.type === 'content_block_delta' && event.delta.type === 'thinking_delta'),
    [
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'trace' },
      },
    ],
  );
});

test('done-only Responses reasoning summary stream emits every summary part once', () => {
  const state = createResponsesToMessagesStreamState();

  const events = [
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.reasoning_summary_text.done',
        item_id: 'rs_0',
        output_index: 0,
        summary_index: 0,
        text: 'first',
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.reasoning_summary_text.done',
        item_id: 'rs_0',
        output_index: 0,
        summary_index: 1,
        text: 'second',
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_0',
          summary: [
            { type: 'summary_text', text: 'first' },
            { type: 'summary_text', text: 'second' },
          ],
        },
      },
      state,
    ),
  ];

  assertEquals(
    events.flatMap(event => (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta' ? [event.delta.thinking] : [])),
    ['first', 'second'],
  );
});

test('opaque-only Responses reasoning stream preserves source order when opaque data arrives late', () => {
  const state = createResponsesToMessagesStreamState();

  const events = [
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_0', summary: [] },
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 1,
        content_index: 0,
        delta: 'answer',
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_0',
          summary: [],
          encrypted_content: 'opaque_sig',
        },
      },
      state,
    ),
  ];

  assertEquals(events, [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'redacted_thinking', data: 'opaque_sig@rs_0' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'answer' },
    },
  ]);
});

test('Responses reasoning stream preserves source order when later reasoning finishes first', () => {
  const state = createResponsesToMessagesStreamState();

  const events = [
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_0', summary: [] },
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'reasoning', id: 'rs_1', summary: [] },
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'second' }],
          encrypted_content: 'enc_second',
        },
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_0',
          summary: [{ type: 'summary_text', text: 'first' }],
          encrypted_content: 'enc_first',
        },
      },
      state,
    ),
  ];

  assertEquals(events, [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'first' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'enc_first@rs_0' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'thinking_delta', thinking: 'second' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'signature_delta', signature: 'enc_second@rs_1' },
    },
  ]);
});

test('Responses stream keeps later text deferred until earlier tool block is done', () => {
  const state = createResponsesToMessagesStreamState();

  const events = [
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'call_0',
          name: 'lookup',
          arguments: '',
          status: 'in_progress',
        },
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_0',
        output_index: 0,
        delta: '{"q":',
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 1,
        content_index: 0,
        delta: 'answer',
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.function_call_arguments.done',
        item_id: 'fc_0',
        output_index: 0,
        arguments: '{"q":1}',
      },
      state,
    ),
    ...translateResponsesStreamEventToMessagesEvents(
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'call_0',
          name: 'lookup',
          arguments: '{"q":1}',
          status: 'completed',
        },
      },
      state,
    ),
  ];

  assertEquals(events, [
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'call_0',
        name: 'lookup',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"q":' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'answer' },
    },
  ]);
});

test('reasoning stream with neither summary nor encrypted_content emits no block', () => {
  const state = createResponsesToMessagesStreamState();

  const events = translateResponsesStreamEventToMessagesEvents(
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'reasoning', id: 'rs_empty', summary: [] },
    },
    state,
  );

  assertEquals(events, []);
});

test('reasoning stream with explicit undefined encrypted_content emits no block', () => {
  const state = createResponsesToMessagesStreamState();

  const events = translateResponsesStreamEventToMessagesEvents(
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'rs_undef',
        summary: [],
        encrypted_content: undefined,
      },
    },
    state,
  );

  assertEquals(events, []);
});

test('reasoning stream with whitespace-only summary and encrypted_content becomes redacted_thinking with packed id', () => {
  const state = createResponsesToMessagesStreamState();

  const events = translateResponsesStreamEventToMessagesEvents(
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'rs_ws',
        summary: [{ type: 'summary_text', text: '   \n  ' }],
        encrypted_content: 'opaque_sig',
      },
    },
    state,
  );

  assertEquals(events, [
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'redacted_thinking',
        data: 'opaque_sig@rs_ws',
      },
    },
  ]);
});
