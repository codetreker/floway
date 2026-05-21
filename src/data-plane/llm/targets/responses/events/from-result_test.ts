import { test } from 'vitest';

import { responsesResultToEvents } from './from-result.ts';
import { assertEquals, assertFalse } from '../../../../../test-assert.ts';
import type { ResponsesResult } from '../../../../shared/protocol/responses.ts';

const completedResponse: ResponsesResult = {
  id: 'resp_completed',
  object: 'response',
  model: 'gpt-test',
  status: 'completed',
  output_text: 'Hello',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello' }],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
};

test('responsesResultToEvents projects terminal JSON into Responses stream events', () => {
  const frames = Array.from(responsesResultToEvents(completedResponse));

  assertEquals(
    frames.map(frame => frame.type),
    ['event', 'event', 'event', 'event', 'event', 'event', 'event', 'event', 'event'],
  );
  assertEquals(
    frames.map(frame => frame.event.type),
    [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ],
  );
});

test('responsesResultToEvents starts JSON fallback streams with an empty in-progress snapshot', () => {
  const frames = Array.from(responsesResultToEvents(completedResponse));
  const created = frames[0].event as {
    type: 'response.created';
    sequence_number: number;
    response: ResponsesResult;
  };
  const completed = frames.at(-1)?.event;

  assertEquals(created.type, 'response.created');
  if (created.type !== 'response.created') throw new Error('unexpected event');
  assertEquals(created.sequence_number, 0);
  assertEquals(created.response.status, 'in_progress');
  assertEquals(created.response.output, []);
  assertEquals(created.response.output_text, '');
  assertFalse('error' in created.response);
  assertFalse('incomplete_details' in created.response);

  assertEquals(completed?.type, 'response.completed');
});

test('responsesResultToEvents keeps incomplete details only on the terminal event', () => {
  const frames = Array.from(
    responsesResultToEvents({
      ...completedResponse,
      id: 'resp_incomplete',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    }),
  );

  const created = frames[0].event as {
    type: 'response.created';
    response: ResponsesResult;
  };
  const terminal = frames.at(-1)?.event as {
    type: 'response.incomplete';
    response: ResponsesResult;
  };

  assertFalse('incomplete_details' in created.response);
  assertEquals(terminal.type, 'response.incomplete');
  assertEquals(terminal.response.incomplete_details?.reason, 'max_output_tokens');
});

test('responsesResultToEvents keeps failure details only on the terminal event', () => {
  const frames = Array.from(
    responsesResultToEvents({
      id: 'resp_failed',
      object: 'response',
      model: 'gpt-test',
      status: 'failed',
      output_text: '',
      output: [],
      error: {
        message: 'upstream failed',
        type: 'server_error',
        code: 'boom',
      },
      usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
    }),
  );

  const created = frames[0].event as {
    type: 'response.created';
    response: ResponsesResult;
  };
  const terminal = frames.at(-1)?.event as {
    type: 'response.failed';
    response: ResponsesResult;
  };

  assertFalse('error' in created.response);
  assertEquals(terminal.type, 'response.failed');
  assertEquals(terminal.response.error?.message, 'upstream failed');
});
