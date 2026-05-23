import { test } from 'vitest';

import { translateMessagesToChatCompletions } from './request.ts';
import { assertEquals } from '../test-assert.ts';

test('translateMessagesToChatCompletions maps thinking.disabled to reasoning_effort none', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning_effort, 'none');
});

test('translateMessagesToChatCompletions prefers output_config.effort over thinking.disabled', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    output_config: { effort: 'high' },
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning_effort, 'high');
});

test('translateMessagesToChatCompletions treats empty output_config.effort as absent', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    output_config: { effort: '' },
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning_effort, 'none');
});

test('translateMessagesToChatCompletions keeps tool_result and user text as separate chat messages', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'result' },
          { type: 'text', text: 'Please continue.' },
        ],
      },
    ],
  });

  assertEquals(result.messages, [
    { role: 'tool', tool_call_id: 'toolu_1', content: 'result' },
    { role: 'user', content: 'Please continue.' },
  ]);
});

test('translateMessagesToChatCompletions drops filtered-native tool_choice and rewrites assistant native web-search history as tool-call history', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    tool_choice: { type: 'any' },
    tools: [{ type: 'web_search_20260209', name: 'NativeSearch' }],
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'server_tool_use',
            id: 'st_1',
            name: 'web_search',
            input: { query: 'React docs' },
          },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'st_1',
            content: [
              {
                type: 'web_search_result',
                url: 'https://react.dev',
                title: 'React',
                encrypted_content: 'cgws1.payload',
              },
            ],
          },
        ],
      },
    ],
  });

  assertEquals(result.tools, undefined);
  assertEquals(result.tool_choice, undefined);
  assertEquals(result.messages, [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'st_1',
          type: 'function',
          function: {
            name: 'web_search',
            arguments: '{"query":"React docs"}',
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'st_1',
      content: '[{"type":"web_search_result","url":"https://react.dev","title":"React","encrypted_content":"cgws1.payload"}]',
    },
  ]);
});

test('translateMessagesToChatCompletions flattens text-block tool_result content but serializes search-result arrays', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_text',
            content: [{ type: 'text', text: 'hello' }],
          },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_search',
            content: [
              {
                type: 'search_result',
                source: 'https://react.dev',
                title: 'React',
                content: [{ type: 'text', text: 'Official docs' }],
              },
            ],
          },
        ],
      },
    ],
  });

  assertEquals(result.messages, [
    { role: 'tool', tool_call_id: 'toolu_text', content: 'hello' },
    {
      role: 'tool',
      tool_call_id: 'toolu_search',
      content: '[{"type":"search_result","source":"https://react.dev","title":"React","content":[{"type":"text","text":"Official docs"}]}]',
    },
  ]);
});

test('translateMessagesToChatCompletions preserves mixed user/tool_result chronology', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'First question.' },
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'first' },
          { type: 'text', text: 'Follow-up.' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'second' },
        ],
      },
    ],
  });

  assertEquals(result.messages, [
    { role: 'user', content: 'First question.' },
    { role: 'tool', tool_call_id: 'toolu_1', content: 'first' },
    { role: 'user', content: 'Follow-up.' },
    { role: 'tool', tool_call_id: 'toolu_2', content: 'second' },
  ]);
});

test('translateMessagesToChatCompletions preserves redacted_thinking as reasoning_opaque', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'redacted_thinking', data: 'opaque_sig' }],
      },
    ],
  });

  assertEquals(result.messages, [
    {
      role: 'assistant',
      content: null,
      reasoning_text: null,
      reasoning_opaque: 'opaque_sig',
    },
  ]);
});

test('translateMessagesToChatCompletions projects only the first scalar reasoning group', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'first', signature: 'sig_1' },
          { type: 'thinking', thinking: 'second', signature: 'sig_2' },
          { type: 'text', text: 'answer' },
        ],
      },
    ],
  });

  assertEquals(result.messages[0], {
    role: 'assistant',
    content: 'answer',
    reasoning_text: 'first',
    reasoning_opaque: 'sig_1',
  });
});

test('translateMessagesToChatCompletions does not pair readable thinking with later redacted opaque data', () => {
  const result = translateMessagesToChatCompletions({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'first' },
          { type: 'redacted_thinking', data: 'opaque_later' },
        ],
      },
    ],
  });

  assertEquals(result.messages[0], {
    role: 'assistant',
    content: null,
    reasoning_text: 'first',
    reasoning_opaque: null,
  });
});
