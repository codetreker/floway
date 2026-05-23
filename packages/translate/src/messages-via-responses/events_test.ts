import { test } from 'vitest';

import { createResponsesToMessagesStreamState, translateResponsesStreamEventToMessagesEvents, translateResponsesToMessagesResponse } from './events.ts';
import { assertEquals, assertFalse } from '../test-assert.ts';

test('Responses reasoning stream without readable summary emits no Messages block', () => {
  const state = createResponsesToMessagesStreamState();

  const events = translateResponsesStreamEventToMessagesEvents(
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'rs_0',
        summary: [],
      },
    },
    state,
  );

  assertEquals(events, []);
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

test('Responses reasoning stream keeps summary text from deltas when done summary is empty', () => {
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

test('opaque-only Responses reasoning stream releases later text when done', () => {
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
        },
      },
      state,
    ),
  ];

  assertEquals(events, [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
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

test('reasoning stream with no summary emits no block', () => {
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

test('reasoning stream with no readable summary emits no block', () => {
  const state = createResponsesToMessagesStreamState();

  const events = translateResponsesStreamEventToMessagesEvents(
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'rs_undef',
        summary: [],
      },
    },
    state,
  );

  assertEquals(events, []);
});

test('reasoning stream with whitespace-only summary emits no block', () => {
  const state = createResponsesToMessagesStreamState();

  const events = translateResponsesStreamEventToMessagesEvents(
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'rs_ws',
        summary: [{ type: 'summary_text', text: '   \n  ' }],
      },
    },
    state,
  );

  assertEquals(events, []);
});

test('translateResponsesToMessagesResponse omits signature for text-only reasoning', () => {
  const result = translateResponsesToMessagesResponse({
    id: 'resp_123',
    object: 'response',
    model: 'gpt-test',
    output: [
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'trace' }],
      },
    ],
    output_text: '',
    status: 'completed',
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    },
  });

  const block = result.content[0];
  assertEquals(block, { type: 'thinking', thinking: 'trace' });
  assertFalse('signature' in block);
});

test('translateResponsesToMessagesResponse drops opaque-only reasoning output', () => {
  const result = translateResponsesToMessagesResponse({
    id: 'resp_123',
    object: 'response',
    model: 'gpt-test',
    output: [
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [],
      },
    ],
    output_text: '',
    status: 'completed',
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    },
  });

  assertEquals(result.content, []);
});

test('translateResponsesToMessagesResponse drops reasoning with no summary', () => {
  const result = translateResponsesToMessagesResponse({
    id: 'resp_drop',
    object: 'response',
    model: 'gpt-test',
    output: [
      { type: 'reasoning', id: 'rs_empty', summary: [] },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hello' }],
      },
    ],
    output_text: 'hello',
    status: 'completed',
    usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
  });

  assertEquals(result.content, [{ type: 'text', text: 'hello' }]);
});

test('translateResponsesToMessagesResponse drops reasoning with no readable summary', () => {
  const result = translateResponsesToMessagesResponse({
    id: 'resp_undef',
    object: 'response',
    model: 'gpt-test',
    output: [
      {
        type: 'reasoning',
        id: 'rs_undef',
        summary: [],
      },
    ],
    output_text: '',
    status: 'completed',
    usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 },
  });

  assertEquals(result.content, []);
});

test('translateResponsesToMessagesResponse drops whitespace-only reasoning summary', () => {
  const result = translateResponsesToMessagesResponse({
    id: 'resp_ws',
    object: 'response',
    model: 'gpt-test',
    output: [
      {
        type: 'reasoning',
        id: 'rs_ws',
        summary: [{ type: 'summary_text', text: '   \n  ' }],
      },
    ],
    output_text: '',
    status: 'completed',
    usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 },
  });

  assertEquals(result.content, []);
});
