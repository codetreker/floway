import { test } from 'vitest';

import { collectChatProtocolEventsToCompletion } from './reassemble.ts';
import { assertEquals, assertRejects } from '../../../../../test-assert.ts';
import type { ChatCompletionResponse } from '../../../../shared/protocol/chat-completions.ts';
import { eventFrame } from '../../../shared/stream/types.ts';
import { chatCompletionResultToEvents } from '../../../targets/chat-completions/events/from-result.ts';

test('collectChatProtocolEventsToCompletion reassembles synthetic Chat chunks', async () => {
  const expected: ChatCompletionResponse = {
    id: 'chatcmpl_1',
    object: 'chat.completion',
    created: 123,
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          reasoning_text: 'think',
          content: 'Hello',
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  };

  async function* events() {
    yield* chatCompletionResultToEvents(expected);
  }

  assertEquals(await collectChatProtocolEventsToCompletion(events()), expected);
});

test('collectChatProtocolEventsToCompletion rejects Chat streams without DONE', async () => {
  async function* events() {
    yield eventFrame({
      id: 'chatcmpl_truncated',
      object: 'chat.completion.chunk' as const,
      created: 123,
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant' as const, content: 'partial' },
          finish_reason: null,
        },
      ],
    });
  }

  await assertRejects(async () => await collectChatProtocolEventsToCompletion(events()), Error, 'Chat Completions stream ended without a DONE sentinel.');
});
