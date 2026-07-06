import { test } from 'vitest';

import type { ChatCompletionsStreamEvent, ChatCompletionsResult } from './index.ts';
import { reassembleChatCompletionsEvents } from './reassemble.ts';
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

test('reassembleChatCompletionsEvents preserves unknown delta fields by concatenating string streams (reasoning_content)', async () => {
  const body = makeEvents([
    {
      data: {
        id: 'cmpl_1',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'deepseek-v4-pro',
        choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'I will compute ' } }],
      },
    },
    {
      data: {
        id: 'cmpl_1',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'deepseek-v4-pro',
        choices: [{ index: 0, delta: { reasoning_content: '17 * 23 = 391.' } }],
      },
    },
    {
      data: {
        id: 'cmpl_1',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'deepseek-v4-pro',
        choices: [{ index: 0, delta: { content: '391' }, finish_reason: 'stop' }],
      },
    },
  ]);

  const result = await reassembleChatCompletionsEvents(body);
  const message = result.choices[0].message as ChatCompletionsResult['choices'][number]['message'] & { reasoning_content?: string };
  assertEquals(message.content, '391');
  assertEquals(message.reasoning_content, 'I will compute 17 * 23 = 391.');
});

test('reassembleChatCompletionsEvents preserves unknown chunk-level fields with last-non-null write wins', async () => {
  const body = makeEvents([
    {
      data: {
        id: 'cmpl_1',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'gpt-test',
        prompt_filter_results: [{ prompt_index: 0, content_filter_results: { hate: { filtered: false } } }],
        choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' } }],
      },
    },
    {
      data: {
        id: 'cmpl_1',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'gpt-test',
        prompt_filter_results: null,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    },
  ]);

  const result = await reassembleChatCompletionsEvents(body) as ChatCompletionsResult & { prompt_filter_results?: unknown };
  assertEquals(result.prompt_filter_results, [{ prompt_index: 0, content_filter_results: { hate: { filtered: false } } }]);
});

test('reassembleChatCompletionsEvents preserves unknown choice-level fields (content_filter_results)', async () => {
  const body = makeEvents([
    {
      data: {
        id: 'cmpl_1',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'gpt-test',
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: 'ok' },
          content_filter_results: { hate: { filtered: false, severity: 'safe' } },
          finish_reason: 'stop',
        }],
      },
    },
  ]);

  const result = await reassembleChatCompletionsEvents(body) as ChatCompletionsResult & {
    choices: [{ content_filter_results?: unknown }];
  };
  assertEquals(result.choices[0].content_filter_results, { hate: { filtered: false, severity: 'safe' } });
});

test('reassembleChatCompletionsEvents carries system_fingerprint without concatenating its repeated chunks', async () => {
  const body = makeEvents([
    {
      data: {
        id: 'cmpl_fp',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'gpt-test',
        system_fingerprint: 'fp_abc123',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' } }],
      },
    },
    {
      data: {
        id: 'cmpl_fp',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'gpt-test',
        system_fingerprint: 'fp_abc123',
        choices: [{ index: 0, delta: { content: ' there' } }],
      },
    },
    {
      data: {
        id: 'cmpl_fp',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'gpt-test',
        system_fingerprint: 'fp_abc123',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    },
  ]);

  const result = await reassembleChatCompletionsEvents(body);
  assertEquals(result.system_fingerprint, 'fp_abc123');
  assertEquals(result.choices[0].message.content, 'hi there');
});

test('reassembleChatCompletionsEvents carries service_tier without concatenating its repeated chunks', async () => {
  const body = makeEvents([
    {
      data: {
        id: 'cmpl_tier',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'gpt-test',
        service_tier: 'priority',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }],
      },
    },
    {
      data: {
        id: 'cmpl_tier',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'gpt-test',
        service_tier: 'priority',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    },
  ]);

  const result = await reassembleChatCompletionsEvents(body);
  assertEquals(result.service_tier, 'priority');
});

test('reassembleChatCompletionsEvents holds first non-empty system_fingerprint when later chunks omit it', async () => {
  const body = makeEvents([
    {
      data: {
        id: 'cmpl_fp_late',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'gpt-test',
        system_fingerprint: null,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'a' } }],
      },
    },
    {
      data: {
        id: 'cmpl_fp_late',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'gpt-test',
        system_fingerprint: 'fp_late',
        choices: [{ index: 0, delta: { content: 'b' } }],
      },
    },
    {
      data: {
        id: 'cmpl_fp_late',
        object: 'chat.completion.chunk',
        created: 1000,
        model: 'gpt-test',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    },
  ]);

  const result = await reassembleChatCompletionsEvents(body);
  assertEquals(result.system_fingerprint, 'fp_late');
});
