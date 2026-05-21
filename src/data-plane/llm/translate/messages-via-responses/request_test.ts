import { test } from 'vitest';

import { translateMessagesToResponses } from './request.ts';
import { assertEquals, assertFalse } from '../../../../test-assert.ts';
import type { ResponseInputReasoning, ResponseOutputReasoning } from '../../../shared/protocol/responses.ts';
import { translateMessagesToResponsesResult } from '../responses-via-messages/result.ts';

test('translateMessagesToResponses synthesizes an rs-prefixed id when the signature is not packed', () => {
  const result = translateMessagesToResponses({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'trace', signature: 'sig' }],
      },
    ],
  });

  if (!Array.isArray(result.input)) throw new Error('expected input array');
  const reasoning = result.input[0] as ResponseInputReasoning;
  assertEquals(reasoning.type, 'reasoning');
  assertEquals(reasoning.id, 'rs_0');
  assertEquals(reasoning.encrypted_content, 'sig');
});

test('translateMessagesToResponses recovers the upstream id from a packed thinking.signature', () => {
  const result = translateMessagesToResponses({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'trace',
            signature: 'enc_abc@rs_42',
          },
        ],
      },
    ],
  });

  if (!Array.isArray(result.input)) throw new Error('expected input array');
  const reasoning = result.input[0] as ResponseInputReasoning;
  assertEquals(reasoning.id, 'rs_42');
  assertEquals(reasoning.encrypted_content, 'enc_abc');
});

test('translateMessagesToResponses drops filtered-native tool_choice and rewrites assistant native web-search history as function-call history', () => {
  const result = translateMessagesToResponses({
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

  assertEquals(result.tools, null);
  assertEquals(result.tool_choice, 'auto');
  assertEquals(result.input, [
    {
      type: 'function_call',
      call_id: 'st_1',
      name: 'web_search',
      arguments: '{"query":"React docs"}',
      status: 'completed',
    },
    {
      type: 'function_call_output',
      call_id: 'st_1',
      output: '[{"type":"web_search_result","url":"https://react.dev","title":"React","encrypted_content":"cgws1.payload"}]',
      status: 'completed',
    },
  ]);
});

test('translateMessagesToResponses maps output_config.effort directly to reasoning.effort', () => {
  const result = translateMessagesToResponses({
    model: 'gpt-test',
    max_tokens: 256,
    output_config: { effort: 'xhigh' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning, { effort: 'xhigh' });
  assertEquals(result.include, ['reasoning.encrypted_content']);
});

test('translateMessagesToResponses prefers output_config.effort over thinking.disabled', () => {
  const result = translateMessagesToResponses({
    model: 'gpt-test',
    max_tokens: 256,
    output_config: { effort: 'high' },
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning, { effort: 'high' });
});

test('translateMessagesToResponses preserves output_config.effort max at the translation boundary', () => {
  const result = translateMessagesToResponses({
    model: 'gpt-test',
    max_tokens: 256,
    output_config: { effort: 'max' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning, { effort: 'max' });
});

test('translateMessagesToResponses preserves max_tokens at the translation boundary', () => {
  const result = translateMessagesToResponses({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.max_output_tokens, 256);
});

test('translateMessagesToResponses maps thinking.disabled to reasoning.effort none', () => {
  const result = translateMessagesToResponses({
    model: 'gpt-test',
    max_tokens: 256,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.reasoning, { effort: 'none' });
  assertEquals(result.include, ['reasoning.encrypted_content']);
});

test('translateMessagesToResponses ignores non-disabled thinking without output_config.effort', () => {
  const result = translateMessagesToResponses({
    model: 'gpt-test',
    max_tokens: 256,
    thinking: { type: 'enabled', budget_tokens: 4096 },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertFalse('reasoning' in result);
});

test('translateMessagesToResponses preserves explicit temperature and omits translated-path defaults', () => {
  const result = translateMessagesToResponses({
    model: 'gpt-test',
    max_tokens: 256,
    temperature: 0.2,
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.temperature, 0.2);
  assertFalse('store' in result);
  assertFalse('parallel_tool_calls' in result);
});

test('translateMessagesToResponses omits temperature when the source omitted it', () => {
  const result = translateMessagesToResponses({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertFalse('temperature' in result);
});

test('translateMessagesToResponses joins multi-block system text with double newlines', () => {
  const result = translateMessagesToResponses({
    model: 'gpt-test',
    max_tokens: 256,
    system: [
      { type: 'text', text: 'Alpha' },
      { type: 'text', text: 'Beta' },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  });

  assertEquals(result.instructions, 'Alpha\n\nBeta');
});

test('translateMessagesToResponses preserves redacted_thinking as opaque reasoning input', () => {
  const result = translateMessagesToResponses({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'redacted_thinking', data: 'opaque_sig' }],
      },
    ],
  });

  if (!Array.isArray(result.input)) throw new Error('expected input array');
  assertEquals(result.input[0], {
    type: 'reasoning',
    id: 'rs_0',
    summary: [],
    encrypted_content: 'opaque_sig',
  });
});

test('translateMessagesToResponses recovers the upstream id from packed redacted_thinking.data', () => {
  const result = translateMessagesToResponses({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'redacted_thinking', data: 'opaque_sig@rs_99' }],
      },
    ],
  });

  if (!Array.isArray(result.input)) throw new Error('expected input array');
  assertEquals(result.input[0], {
    type: 'reasoning',
    id: 'rs_99',
    summary: [],
    encrypted_content: 'opaque_sig',
  });
});

test('translateMessagesToResponses omits encrypted_content for text-only thinking input', () => {
  const result = translateMessagesToResponses({
    model: 'gpt-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'trace' }],
      },
    ],
  });

  if (!Array.isArray(result.input)) throw new Error('expected input array');
  const reasoning = result.input[0] as ResponseInputReasoning;
  assertEquals(reasoning, {
    type: 'reasoning',
    id: 'rs_0',
    summary: [{ type: 'summary_text', text: 'trace' }],
  });
  assertFalse('encrypted_content' in reasoning);
});

test('translateMessagesToResponsesResult synthesizes an rs-prefixed id when the signature is not packed', () => {
  const result = translateMessagesToResponsesResult({
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [{ type: 'thinking', thinking: 'trace', signature: 'sig' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 3 },
  });

  const reasoning = result.output[0] as ResponseOutputReasoning;
  assertEquals(reasoning.type, 'reasoning');
  assertEquals(reasoning.id, 'rs_0');
  assertEquals(reasoning.encrypted_content, 'sig');
});

test('translateMessagesToResponsesResult recovers the upstream id from a packed thinking.signature', () => {
  const result = translateMessagesToResponsesResult({
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [
      {
        type: 'thinking',
        thinking: 'trace',
        signature: 'enc_abc@rs_77',
      },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 3 },
  });

  const reasoning = result.output[0] as ResponseOutputReasoning;
  assertEquals(reasoning.id, 'rs_77');
  assertEquals(reasoning.encrypted_content, 'enc_abc');
});

test('translateMessagesToResponsesResult preserves assistant block order', () => {
  const result = translateMessagesToResponsesResult({
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [
      { type: 'text', text: 'Before' },
      { type: 'tool_use', id: 'tool_1', name: 'lookup', input: { q: 1 } },
      { type: 'text', text: 'After' },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 3 },
  });

  assertEquals(result.output, [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Before' }],
    },
    {
      type: 'function_call',
      call_id: 'tool_1',
      name: 'lookup',
      arguments: '{"q":1}',
      status: 'completed',
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'After' }],
    },
  ]);
  assertEquals(result.output_text, 'BeforeAfter');
});

test('translateMessagesToResponsesResult preserves redacted_thinking as opaque reasoning output', () => {
  const result = translateMessagesToResponsesResult({
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [{ type: 'redacted_thinking', data: 'opaque_sig' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 3 },
  });

  assertEquals(result.output, [
    {
      type: 'reasoning',
      id: 'rs_0',
      summary: [],
      encrypted_content: 'opaque_sig',
    },
  ]);
});

test('translateMessagesToResponsesResult recovers the upstream id from packed redacted_thinking.data', () => {
  const result = translateMessagesToResponsesResult({
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [{ type: 'redacted_thinking', data: 'opaque_sig@rs_55' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 3 },
  });

  assertEquals(result.output, [
    {
      type: 'reasoning',
      id: 'rs_55',
      summary: [],
      encrypted_content: 'opaque_sig',
    },
  ]);
});

test('translateMessagesToResponsesResult omits encrypted_content for text-only thinking output', () => {
  const result = translateMessagesToResponsesResult({
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [{ type: 'thinking', thinking: 'trace' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 3 },
  });

  const reasoning = result.output[0] as ResponseOutputReasoning;
  assertEquals(reasoning, {
    type: 'reasoning',
    id: 'rs_0',
    summary: [{ type: 'summary_text', text: 'trace' }],
  });
  assertFalse('encrypted_content' in reasoning);
});

test('translateMessagesToResponsesResult includes cache_creation_input_tokens in input_tokens', () => {
  const result = translateMessagesToResponsesResult({
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [{ type: 'text', text: 'Hello' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
    },
  });

  assertEquals(result.usage!.input_tokens, 150); // 100 + 20 + 30
  assertEquals(result.usage!.output_tokens, 50);
  assertEquals(result.usage!.total_tokens, 200);
  assertEquals(result.usage!.input_tokens_details!.cached_tokens, 20);
});

test('translateMessagesToResponsesResult handles cache_creation without cache_read', () => {
  const result = translateMessagesToResponsesResult({
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [{ type: 'text', text: 'Hello' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 30,
    },
  });

  assertEquals(result.usage!.input_tokens, 130); // 100 + 0 + 30
  assertEquals(result.usage!.total_tokens, 180);
  assertEquals(result.usage!.input_tokens_details, undefined);
});
