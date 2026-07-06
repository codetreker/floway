import { test } from 'vitest';

import { createUpstreamLatencyRecorder, requireRecordedDurationMs } from './performance.ts';
import { assert, assertEquals, assertThrows } from '@floway-dev/test-utils';

// Defer settle so the test can observe pre/post-settle state without racing
// the immediate microtask. resolve(value) only after the test deliberately
// awaits the next tick.
const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};

test('createUpstreamLatencyRecorder.durationMs returns null when record was never called', () => {
  const recorder = createUpstreamLatencyRecorder();
  // The recorder honestly reports "no measurement"; per-call-site asserts
  // decide whether that's a bug. requireRecordedDurationMs is the helper
  // for the success-side asserts.
  assertEquals(recorder.durationMs(), null);
  assertThrows(() => requireRecordedDurationMs(recorder, 'test'), Error, 'recordUpstreamLatency');
});

test('createUpstreamLatencyRecorder.durationMs returns the wrapped promise duration', async () => {
  const recorder = createUpstreamLatencyRecorder();
  const d = deferred<string>();
  const wrapped = recorder.record(d.promise);
  d.resolve('ok');
  assertEquals(await wrapped, 'ok');
  // The recorder measures up to settle; for a deferred resolution that's
  // ~0 ms but always non-negative.
  const duration = recorder.durationMs();
  assert(duration !== null && duration >= 0);
});

test('createUpstreamLatencyRecorder retries: most-recent invocation wins', async () => {
  const recorder = createUpstreamLatencyRecorder();
  // First wrap settles immediately so its duration is captured first.
  await recorder.record(Promise.resolve('first'));
  const firstDuration = requireRecordedDurationMs(recorder, 'first');

  // Second wrap: hop the microtask queue many times before resolving so its
  // measured duration is reliably larger than the first's. Macrotask
  // alternatives (setTimeout) are flaky under fake timers; chained awaits on
  // real `performance.now()` ticks are deterministic enough to assert strict
  // inequality, which fails any implementation that doesn't overwrite `last`.
  const second = recorder.record((async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
    return 'second';
  })());
  assertEquals(await second, 'second');
  const secondDuration = requireRecordedDurationMs(recorder, 'second');
  assert(secondDuration > firstDuration, `expected last-wins; got ${secondDuration} vs first ${firstDuration}`);
});

test('createUpstreamLatencyRecorder.record propagates rejection without swallowing', async () => {
  const recorder = createUpstreamLatencyRecorder();
  const rejection = new Error('boom');
  let caught: unknown = null;
  try {
    await recorder.record(Promise.reject(rejection));
  } catch (e) {
    caught = e;
  }
  assertEquals(caught, rejection);
  // Even on rejection, durationMs must be available — the contract is "wrap
  // happened", not "wrap succeeded".
  const duration = recorder.durationMs();
  assert(duration !== null && duration >= 0);
});
