import { describe, expect, test } from 'vitest';

import { traverseTranslation } from './translate-traverse.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';

// Fake event types — no real protocol types needed.
type SrcEvent = { kind: 'src'; value: string };
type TgtEvent = { kind: 'tgt'; value: string };

const translate = async (payload: string): Promise<{
  target: string;
  events: (e: AsyncIterable<ProtocolFrame<TgtEvent>>) => AsyncIterable<ProtocolFrame<SrcEvent>>;
}> => ({
  target: `translated(${payload})`,
  async *events(frames) {
    for await (const frame of frames) {
      if (frame.type === 'done') {
        yield doneFrame();
      } else {
        yield eventFrame({ kind: 'src', value: frame.event.value });
      }
    }
  },
});

const makeTgtFrames = async function* (values: string[]): AsyncGenerator<ProtocolFrame<TgtEvent>> {
  for (const v of values) yield eventFrame({ kind: 'tgt', value: v });
  yield doneFrame();
};

const collectFrames = async (iterable: AsyncIterable<ProtocolFrame<SrcEvent>>): Promise<ProtocolFrame<SrcEvent>[]> => {
  const out: ProtocolFrame<SrcEvent>[] = [];
  for await (const frame of iterable) out.push(frame);
  return out;
};

const fakeModelIdentity = { modelId: 'fake' } as never;

describe('traverseTranslation', () => {
  test('events inner — outer wraps with trip.events', async () => {
    const innerAttempt = async (_translated: string): Promise<ExecuteResult<ProtocolFrame<TgtEvent>>> => ({
      type: 'events',
      events: makeTgtFrames(['a', 'b']),
      modelIdentity: fakeModelIdentity,
    });

    const result = await traverseTranslation('payload', translate, innerAttempt);

    expect(result.type).toBe('events');
    if (result.type !== 'events') throw new Error('unreachable');

    const frames = await collectFrames(result.events);
    expect(frames).toEqual([
      { type: 'event', event: { kind: 'src', value: 'a' } },
      { type: 'event', event: { kind: 'src', value: 'b' } },
      { type: 'done' },
    ]);
    expect(result.modelIdentity).toBe(fakeModelIdentity);
  });

  test('result inner — outer returns the result unchanged', async () => {
    const inner: ExecuteResult<ProtocolFrame<TgtEvent>> = {
      type: 'upstream-error',
      status: 404,
      headers: new Headers(),
      body: new Uint8Array(),
    };
    const innerAttempt = async (_translated: string): Promise<ExecuteResult<ProtocolFrame<TgtEvent>>> => inner;

    const result = await traverseTranslation('payload', translate, innerAttempt);

    expect(result).toBe(inner);
  });

  test('failure inner — outer returns the failure unchanged', async () => {
    const inner: ExecuteResult<ProtocolFrame<TgtEvent>> = {
      type: 'internal-error',
      status: 500,
      error: new Error('boom') as never,
    };
    const innerAttempt = async (_translated: string): Promise<ExecuteResult<ProtocolFrame<TgtEvent>>> => inner;

    const result = await traverseTranslation('payload', translate, innerAttempt);

    expect(result).toBe(inner);
  });
});
