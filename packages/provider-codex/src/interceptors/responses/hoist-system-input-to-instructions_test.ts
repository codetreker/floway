import { test } from 'vitest';

import { hoistSystemInputToInstructions } from './hoist-system-input-to-instructions.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { assertEquals, stubUpstreamModel } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ProviderStreamResult<ResponsesStreamEvent>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test' });

const invocation = (payload: ResponsesPayload): ResponsesBoundaryCtx => ({
  payload,
  headers: {},
  model: stubUpstreamModel({ endpoints: { responses: {} } }),
});

test('hoists role:"system" text from input into instructions', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      { type: 'message', role: 'system', content: 'Always lowercase.' },
      { type: 'message', role: 'user', content: 'HI' },
    ],
  });

  await hoistSystemInputToInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.instructions, 'Always lowercase.');
  assertEquals(ctx.payload.input, [{ type: 'message', role: 'user', content: 'HI' }]);
});

test('appends after existing instructions with a blank-line separator', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    instructions: 'You are helpful.',
    input: [
      { type: 'message', role: 'system', content: 'Always lowercase.' },
      { type: 'message', role: 'user', content: 'HI' },
    ],
  });

  await hoistSystemInputToInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.instructions, 'You are helpful.\n\nAlways lowercase.');
});

test('concatenates multiple system items in order', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      { type: 'message', role: 'system', content: 'Rule one.' },
      { type: 'message', role: 'user', content: 'first' },
      { type: 'message', role: 'system', content: 'Rule two.' },
      { type: 'message', role: 'user', content: 'second' },
    ],
  });

  await hoistSystemInputToInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.instructions, 'Rule one.\n\nRule two.');
  assertEquals(ctx.payload.input, [
    { type: 'message', role: 'user', content: 'first' },
    { type: 'message', role: 'user', content: 'second' },
  ]);
});

test('passes role:"developer" through (Codex accepts it)', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      { type: 'message', role: 'developer', content: 'Use lowercase.' },
      { type: 'message', role: 'user', content: 'HI' },
    ],
  });

  await hoistSystemInputToInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.input, [
    { type: 'message', role: 'developer', content: 'Use lowercase.' },
    { type: 'message', role: 'user', content: 'HI' },
  ]);
  assertEquals(ctx.payload.instructions, undefined);
});

test('flattens content-part arrays (input_text + output_text)', async () => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'message', role: 'system', content: [
          { type: 'input_text', text: 'Always' },
          { type: 'input_text', text: 'lowercase.' },
        ],
      },
      { type: 'message', role: 'user', content: 'HI' },
    ],
  });

  await hoistSystemInputToInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.instructions, 'Always\nlowercase.');
});

test('no-op when input has no system items', async () => {
  const original = [{ type: 'message', role: 'user', content: 'HI' }] as const;
  const ctx = invocation({ model: 'gpt-test', input: [...original] });

  await hoistSystemInputToInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.input, [...original]);
  assertEquals(ctx.payload.instructions, undefined);
});

test('no-op when input is a string (convenience form)', async () => {
  const ctx = invocation({ model: 'gpt-test', input: 'just user text' });

  await hoistSystemInputToInstructions(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.input, 'just user text');
});
