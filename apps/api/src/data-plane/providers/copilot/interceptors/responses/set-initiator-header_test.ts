import { test } from 'vitest';

import { withInitiatorHeaderSet } from './set-initiator-header.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '../../../../../test-helpers.ts';
import type { RequestContext, ResponsesInvocation } from '../../../../llm/interceptors.ts';
import { eventResult, type ExecuteResult } from '../../../../llm/shared/errors/result.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  runtimeLocation: 'test',
  clientStream: false,
};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: ResponsesPayload): ResponsesInvocation => ({
  sourceApi: 'responses',
  targetApi: 'responses',
  model: payload.model,
  upstream: 'test-upstream',
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags: new Set<string>(),
  headers: {},
});

test('Responses initiator is user when the last input item is a plain user message', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ],
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['x-initiator'], 'user');
});

test('Responses initiator is user when input is a plain string', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: 'plain string input',
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['x-initiator'], 'user');
});

test('Responses initiator is user when input is an empty array', async () => {
  const ctx = invocation({ model: 'gpt-test', input: [] });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['x-initiator'], 'user');
});

test('Responses initiator is agent when the last input item is a function_call_output', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'do the thing' }],
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'do_thing',
        arguments: '{}',
        status: 'completed',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'done',
      },
    ],
  });

  await withInitiatorHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['x-initiator'], 'agent');
});
