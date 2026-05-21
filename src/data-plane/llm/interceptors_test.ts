import { test } from 'vitest';

import { type Interceptor, runInterceptors } from './interceptors.ts';
import { assertEquals } from '../../test-assert.ts';
import { eventResult, type StreamExecuteResult } from './shared/errors/result.ts';
import { eventFrame } from './shared/stream/types.ts';

const collectFrames = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const frames: T[] = [];
  for await (const frame of events) frames.push(frame);
  return frames;
};

const testTelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key',
};

type TestResult = StreamExecuteResult<string>;

test('runInterceptors lets an interceptor patch context before run and patch result after run', async () => {
  const ctx = { payload: { value: 'original' } };

  const interceptor: Interceptor<typeof ctx, TestResult> = async (current, run) => {
    current.payload.value = 'patched';
    const patched = current.payload.value;
    const result = await run();
    if (result.type !== 'events') return result;

    return {
      ...result,
      events: (async function* () {
        for await (const frame of result.events) {
          yield frame.type === 'event' ? eventFrame(`${frame.event}:${patched}`) : frame;
        }
      })(),
    };
  };

  const result = await runInterceptors(ctx, [interceptor], () => Promise.resolve(makeResult(ctx.payload.value)));

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('expected events result');
  assertEquals(ctx.payload.value, 'patched');
  assertEquals(await collectFrames(result.events), [eventFrame('patched:patched')]);
});

test('runInterceptors composes interceptors in nested order', async () => {
  const calls: string[] = [];
  const ctx = { payload: { value: 'ok' } };

  const outer: Interceptor<typeof ctx, TestResult> = async (_ctx, run) => {
    calls.push('outer-before');
    const result = await run();
    calls.push('outer-after');
    return result;
  };
  const inner: Interceptor<typeof ctx, TestResult> = async (_ctx, run) => {
    calls.push('inner-before');
    const result = await run();
    calls.push('inner-after');
    return result;
  };

  await runInterceptors(ctx, [outer, inner], () => {
    calls.push('terminal');
    return Promise.resolve(makeResult(ctx.payload.value));
  });

  assertEquals(calls, ['outer-before', 'inner-before', 'terminal', 'inner-after', 'outer-after']);
});

test('runInterceptors lets an interceptor inspect an upstream error and retry', async () => {
  const ctx = { payload: { value: 'broken' } };
  let attempts = 0;

  const interceptor: Interceptor<typeof ctx, TestResult> = async (current, run) => {
    const first = await run();
    if (first.type !== 'upstream-error') return first;

    current.payload.value = 'fixed';
    return await run();
  };

  const result = await runInterceptors(ctx, [interceptor], () => {
    attempts += 1;
    return Promise.resolve(
      attempts === 1
        ? {
            type: 'upstream-error' as const,
            status: 400,
            headers: new Headers(),
            body: new TextEncoder().encode('{"error":{"message":"broken"}}'),
          }
        : makeResult(ctx.payload.value),
    );
  });

  assertEquals(attempts, 2);
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('expected events result');
  assertEquals(await collectFrames(result.events), [eventFrame('fixed')]);
});

const makeResult = (value: string): TestResult =>
  eventResult(
    (async function* () {
      yield eventFrame(value);
    })(),
    testTelemetryModelIdentity,
  );
