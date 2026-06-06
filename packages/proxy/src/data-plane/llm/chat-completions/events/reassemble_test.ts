import { test } from 'vitest';

import { reassembleChatCompletionsEvents } from './reassemble.ts';
import type { ChatCompletionsStreamEvent, ChatCompletionsResult } from '@floway-dev/protocols/chat-completions';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

function makeEvents<T = ChatCompletionsStreamEvent>(chunks: Array<{ event?: string; data: unknown }>): AsyncIterable<T> {
  return (async function* () {
    for (const chunk of chunks) {
      if (typeof chunk.data === 'string') continue;

      const data = chunk.data as Record<string, unknown>;
      yield (chunk.event && typeof data.type !== 'string' ? { ...data, type: chunk.event } : data) as T;
    }
  })();
}

test('reassembleChatCompletionsEvents reassembles text response', async () => {
  const body = makeEvents([
    {
      data: {
        id: 'cmpl_1',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'Hello' },
            finish_reason: null,
          },
        ],
      },
    },
    {
      data: {
        id: 'cmpl_1',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            delta: { content: ' world' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    },
    { data: '[DONE]' },
  ]);

  const result: ChatCompletionsResult = await reassembleChatCompletionsEvents(body);

  assertEquals(result.id, 'cmpl_1');
  assertEquals(result.model, 'gpt-test');
  assertEquals(result.created, 1000);
  assertEquals(result.object, 'chat.completion');
  assertEquals(result.choices.length, 1);
  assertEquals(result.choices[0].index, 0);
  assertEquals(result.choices[0].message.content, 'Hello world');
  assertEquals(result.choices[0].finish_reason, 'stop');
  assertEquals(result.usage?.prompt_tokens, 10);
});

test('reassembleChatCompletionsEvents rejects upstream Chat error payloads', async () => {
  const body = makeEvents([
    {
      data: {
        error: {
          type: 'server_error',
          message: 'upstream chat failed',
        },
      },
    },
  ]);

  await assertRejects(async () => await reassembleChatCompletionsEvents(body), Error, 'Upstream Chat Completions SSE error: server_error: upstream chat failed');
});

test('reassembleChatCompletionsEvents reassembles tool calls', async () => {
  const body = makeEvents([
    {
      data: {
        id: 'cmpl_2',
        object: 'chat.completion.chunk',
        created: 2000,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"city"' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
    },
    {
      data: {
        id: 'cmpl_2',
        object: 'chat.completion.chunk',
        created: 2000,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: ':"Tokyo"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    },
    { data: '[DONE]' },
  ]);

  const result = await reassembleChatCompletionsEvents(body);

  assertEquals(result.choices[0].finish_reason, 'tool_calls');
  assertEquals(result.choices[0].message.tool_calls?.length, 1);
  assertEquals(result.choices[0].message.tool_calls![0].id, 'call_1');
  assertEquals(result.choices[0].message.tool_calls![0].function.name, 'lookup');
  assertEquals(result.choices[0].message.tool_calls![0].function.arguments, '{"city":"Tokyo"}');
});

test('reassembleChatCompletionsEvents reassembles reasoning fields', async () => {
  const body = makeEvents([
    {
      data: {
        id: 'cmpl_3',
        object: 'chat.completion.chunk',
        created: 3000,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              reasoning_text: 'think',
              reasoning_opaque: 'enc',
            },
            finish_reason: null,
          },
        ],
      },
    },
    {
      data: {
        id: 'cmpl_3',
        object: 'chat.completion.chunk',
        created: 3000,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            delta: { content: 'reply' },
            finish_reason: 'stop',
          },
        ],
      },
    },
    { data: '[DONE]' },
  ]);

  const result = await reassembleChatCompletionsEvents(body);

  assertEquals(result.choices[0].message.reasoning_text, 'think');
  assertEquals(result.choices[0].message.reasoning_opaque, 'enc');
  assertEquals(result.choices[0].message.content, 'reply');
});

test('reassembleChatCompletionsEvents appends reasoning_items deltas in order', async () => {
  const body = makeEvents([
    {
      data: {
        id: 'cmpl_reasoning_items',
        object: 'chat.completion.chunk',
        created: 3001,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              reasoning_items: [
                {
                  type: 'reasoning',
                  id: 'rs_1',
                  summary: [{ type: 'summary_text', text: 'first' }],
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
    },
    {
      data: {
        id: 'cmpl_reasoning_items',
        object: 'chat.completion.chunk',
        created: 3001,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            delta: {
              reasoning_items: [
                {
                  type: 'reasoning',
                  id: 'rs_2',
                  summary: [],
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
    },
    {
      data: {
        id: 'cmpl_reasoning_items',
        object: 'chat.completion.chunk',
        created: 3001,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            delta: { content: 'reply' },
            finish_reason: 'stop',
          },
        ],
      },
    },
    { data: '[DONE]' },
  ]);

  const result = await reassembleChatCompletionsEvents(body);

  assertEquals(result.choices[0].message.reasoning_items, [
    {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'first' }],
    },
    {
      type: 'reasoning',
      id: 'rs_2',
      summary: [],
    },
  ]);
  assertEquals(result.choices[0].message.content, 'reply');
});
