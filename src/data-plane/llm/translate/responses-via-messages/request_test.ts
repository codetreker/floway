import { test } from 'vitest';

import { translateResponsesToMessages } from './request.ts';
import { assertEquals, assertFalse } from '../../../../test-assert.ts';
import { MESSAGES_FALLBACK_MAX_TOKENS } from '../../../shared/protocol/messages.ts';
import { translateResponsesToMessagesResponse } from '../messages-via-responses/result.ts';

const stubRemoteImageLoader = (result: { mediaType: string | null; data: Uint8Array } | null) => () => Promise.resolve(result);

test('translateResponsesToMessages maps reasoning.effort none to thinking.disabled', async () => {
  const result = await translateResponsesToMessages({
    model: 'claude-test',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: 256,
    tools: null,
    tool_choice: 'auto',
    metadata: null,
    stream: null,
    store: false,
    parallel_tool_calls: true,
    reasoning: { effort: 'none', summary: 'detailed' },
  });

  assertEquals(result.thinking, { type: 'disabled' });
  assertFalse('output_config' in result);
});

test('translateResponsesToMessages maps reasoning.effort directly to output_config.effort', async () => {
  const result = await translateResponsesToMessages({
    model: 'claude-test',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: 256,
    tools: null,
    tool_choice: 'auto',
    metadata: null,
    stream: null,
    store: false,
    parallel_tool_calls: true,
    reasoning: { effort: 'minimal', summary: 'detailed' },
  });

  assertEquals(result.output_config, { effort: 'minimal' });
  assertFalse('thinking' in result);
});

test('translateResponsesToMessages defaults max_tokens to MESSAGES_FALLBACK_MAX_TOKENS when neither source nor fallbackMaxOutputTokens supplies one', async () => {
  const result = await translateResponsesToMessages({
    model: 'claude-test',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: null,
    tools: null,
    tool_choice: 'auto',
    metadata: null,
    stream: null,
    store: false,
    parallel_tool_calls: true,
  });

  assertEquals(result.max_tokens, MESSAGES_FALLBACK_MAX_TOKENS);
});

test('translateResponsesToMessages uses fallbackMaxOutputTokens over the gateway const when the source omitted max_output_tokens', async () => {
  const result = await translateResponsesToMessages(
    {
      model: 'claude-test',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
      instructions: null,
      temperature: null,
      top_p: null,
      max_output_tokens: null,
      tools: null,
      tool_choice: 'auto',
      metadata: null,
      stream: null,
      store: false,
      parallel_tool_calls: true,
    },
    { fallbackMaxOutputTokens: 4096 },
  );

  assertEquals(result.max_tokens, 4096);
});

test('translateResponsesToMessages packs reasoning id into the Anthropic signature', async () => {
  const result = await translateResponsesToMessages({
    model: 'claude-test',
    input: [
      {
        type: 'reasoning',
        id: 'rs_42',
        summary: [{ type: 'summary_text', text: 'trace' }],
        encrypted_content: 'enc_abc',
      },
    ],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: 256,
    tools: null,
    tool_choice: 'auto',
    metadata: null,
    stream: null,
    store: false,
    parallel_tool_calls: true,
  });

  const assistant = result.messages[0];
  if (assistant.role !== 'assistant' || !Array.isArray(assistant.content)) {
    throw new Error('expected assistant message with content blocks');
  }

  assertEquals(assistant.content[0], {
    type: 'thinking',
    thinking: 'trace',
    signature: 'enc_abc@rs_42',
  });
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

test('translateResponsesToMessages omits generic metadata instead of coercing it to metadata.user_id', async () => {
  const result = await translateResponsesToMessages({
    model: 'claude-test',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: 256,
    tools: null,
    tool_choice: 'auto',
    metadata: { trace_id: 'trace_123' },
    stream: null,
    store: false,
    parallel_tool_calls: true,
  });

  assertFalse('metadata' in result);
});

test('translateResponsesToMessages resolves remote input images through the shared loader', async () => {
  const result = await translateResponsesToMessages(
    {
      model: 'claude-test',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_image',
              image_url: 'https://example.com/image.png',
              detail: 'auto',
            },
          ],
        },
      ],
      instructions: null,
      temperature: null,
      top_p: null,
      max_output_tokens: 256,
      tools: null,
      tool_choice: 'auto',
      metadata: null,
      stream: null,
      store: false,
      parallel_tool_calls: true,
    },
    {
      loadRemoteImage: stubRemoteImageLoader({
        mediaType: 'image/png',
        data: new Uint8Array([1, 2, 3]),
      }),
    },
  );

  const message = result.messages[0];
  if (message.role !== 'user' || !Array.isArray(message.content)) {
    throw new Error('expected user message with content blocks');
  }

  assertEquals(message.content, [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'AQID',
      },
    },
  ]);
});

test('translateResponsesToMessagesResponse packs reasoning id into opaque-only redacted_thinking data', () => {
  const result = translateResponsesToMessagesResponse({
    id: 'resp_123',
    object: 'response',
    model: 'gpt-test',
    output: [
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [],
        encrypted_content: 'opaque_sig',
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

  assertEquals(result.content, [
    {
      type: 'redacted_thinking',
      data: 'opaque_sig@rs_1',
    },
  ]);
});

test('translateResponsesToMessagesResponse drops reasoning with neither summary nor encrypted_content', () => {
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

test('translateResponsesToMessagesResponse drops reasoning with explicit undefined encrypted_content', () => {
  const result = translateResponsesToMessagesResponse({
    id: 'resp_undef',
    object: 'response',
    model: 'gpt-test',
    output: [
      {
        type: 'reasoning',
        id: 'rs_undef',
        summary: [],
        encrypted_content: undefined,
      },
    ],
    output_text: '',
    status: 'completed',
    usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 },
  });

  assertEquals(result.content, []);
});

test('translateResponsesToMessagesResponse treats whitespace-only summary as opaque-only reasoning and packs id', () => {
  const result = translateResponsesToMessagesResponse({
    id: 'resp_ws',
    object: 'response',
    model: 'gpt-test',
    output: [
      {
        type: 'reasoning',
        id: 'rs_ws',
        summary: [{ type: 'summary_text', text: '   \n  ' }],
        encrypted_content: 'opaque_sig',
      },
    ],
    output_text: '',
    status: 'completed',
    usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 },
  });

  assertEquals(result.content, [
    {
      type: 'redacted_thinking',
      data: 'opaque_sig@rs_ws',
    },
  ]);
});

test('translateResponsesToMessages drops opaque-only reasoning input with explicit undefined encrypted_content', async () => {
  const result = await translateResponsesToMessages({
    model: 'gpt-test',
    input: [
      { type: 'message', role: 'user', content: 'hi' },
      {
        type: 'reasoning',
        id: 'rs_undef',
        summary: [],
        encrypted_content: undefined,
      },
      { type: 'message', role: 'user', content: 'follow up' },
    ],
    instructions: null,
    temperature: null,
    top_p: null,
    max_output_tokens: 256,
    tools: null,
    tool_choice: 'auto',
    metadata: null,
    stream: null,
    store: false,
    parallel_tool_calls: true,
  });

  // The undefined-encrypted_content reasoning item is dropped, so the two
  // adjacent user messages remain side-by-side without an injected assistant
  // turn.
  assertEquals(
    result.messages.map(m => ({ role: m.role, content: m.content })),
    [
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'follow up' },
    ],
  );
});
