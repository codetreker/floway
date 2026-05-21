import { Hono } from 'hono';
import { test } from 'vitest';

import { respondGemini } from './respond.ts';
import { assertEquals, assertExists } from '../../../../test-assert.ts';
import type { GeminiErrorResponse } from '../../../shared/protocol/gemini.ts';
import type { InternalDebugError } from '../../shared/errors/internal-debug-error.ts';
import type { StreamExecuteResult } from '../../shared/errors/result.ts';
import { eventFrame } from '../../shared/stream/types.ts';
import type { SourceExecutionContext } from '../execute.ts';

const encoder = new TextEncoder();

const testTelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key',
};
const recordUsage = () => Promise.resolve();
const recordRequestPerformance = () => {};
const source = (): SourceExecutionContext => ({
  requestStartedAt: performance.now(),
  runtimeLocation: 'test',
  recordUsage,
  recordRequestPerformance,
  beginDownstream: () => undefined,
  rememberPerformance: result => result,
});

const requestGeminiResponse = async (result: StreamExecuteResult<GeminiErrorResponse>): Promise<Response> => {
  const app = new Hono();
  app.get('/', c => respondGemini(c, result, false, source()));
  return await app.request('/');
};

test('respondGemini preserves non-stream Gemini error event HTTP code', async () => {
  const errorEvent: GeminiErrorResponse = {
    error: {
      code: 504,
      status: 'DEADLINE_EXCEEDED',
      message: 'timeout',
    },
  };

  const response = await requestGeminiResponse({
    type: 'events',
    events: (async function* () {
      yield eventFrame(errorEvent);
    })(),
    modelIdentity: testTelemetryModelIdentity,
  });

  assertEquals(response.status, 504);
  assertEquals(await response.json(), errorEvent);
});

test('respondGemini preserves upstream Google RPC Status body', async () => {
  const upstreamBody: GeminiErrorResponse = {
    error: {
      code: 412,
      status: 'FAILED_PRECONDITION',
      message: 'account is not ready',
    },
  };

  const response = await requestGeminiResponse({
    type: 'upstream-error',
    status: 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: encoder.encode(JSON.stringify(upstreamBody)),
  });

  assertEquals(response.status, 412);
  assertEquals(await response.json(), upstreamBody);
});

test('respondGemini internal errors include debug fields in Google RPC Status', async () => {
  const error: InternalDebugError = {
    type: 'internal_error',
    name: 'TypeError',
    message: 'boom',
    stack: 'TypeError: boom\n    at test',
    cause: { upstream: 'bad shape' },
    source_api: 'messages',
    target_api: 'responses',
  };

  const response = await requestGeminiResponse({
    type: 'internal-error',
    status: 502,
    error,
  });
  const body = await response.json();

  assertEquals(response.status, 502);
  assertEquals(body.error.code, 502);
  assertEquals(body.error.status, 'UNAVAILABLE');
  assertEquals(body.error.message, 'boom');
  assertEquals(body.error.stack, error.stack);
  assertEquals(body.error.source_api, 'messages');
  assertEquals(body.error.target_api, 'responses');
  assertExists(body.error.cause);
});
