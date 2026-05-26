import { test } from 'vitest';

import { withAnthropicBetaHeaderFiltered } from './filter-anthropic-beta-header.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '../../../../../test-helpers.ts';
import type { MessagesInvocation, RequestContext } from '../../../../llm/interceptors.ts';
import { eventResult, type ExecuteResult } from '../../../../llm/shared/errors/result.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEventData } from '@floway-dev/protocols/messages';

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  runtimeLocation: 'test',
  clientStream: false,
};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEventData>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> {})(), testTelemetryModelIdentity));

const invocation = (payload: MessagesPayload, anthropicBeta?: readonly string[]): MessagesInvocation => ({
  sourceApi: 'messages',
  targetApi: 'messages',
  model: payload.model,
  upstream: 'test-upstream',
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags: new Set<string>(),
  headers: {},
  ...(anthropicBeta !== undefined ? { anthropicBeta } : {}),
});

test('forwards inbound interleaved-thinking unchanged when paired with non-adaptive budget thinking', async () => {
  const ctx = invocation(
    {
      model: 'claude-test',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 1024 },
    },
    ['interleaved-thinking-2025-05-14'],
  );

  await withAnthropicBetaHeaderFiltered(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['anthropic-beta'], 'interleaved-thinking-2025-05-14');
});

test('drops inbound interleaved-thinking when adaptive thinking is requested', async () => {
  // Adaptive thinking is incompatible with the interleaved-thinking beta;
  // caozhiyuan/copilot-api's buildAnthropicBetaHeader filters it out at the
  // inbound stage and never re-adds it (the auto-add branch only fires for
  // non-adaptive budget thinking).
  const ctx = invocation(
    {
      model: 'claude-test',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'adaptive' },
    },
    ['interleaved-thinking-2025-05-14'],
  );

  await withAnthropicBetaHeaderFiltered(ctx, stubRequest, okEvents);

  assertEquals('anthropic-beta' in ctx.headers, false);
});

test('auto-adds interleaved-thinking when caller sent no header and budget_tokens is set without adaptive thinking', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'enabled', budget_tokens: 1024 },
  });

  await withAnthropicBetaHeaderFiltered(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['anthropic-beta'], 'interleaved-thinking-2025-05-14');
});

test('combines inbound context-management with auto-added interleaved-thinking on non-adaptive budget thinking', async () => {
  // Combined-behavior fixture: caozhiyuan's helper runs the inbound filter
  // and the budget-driven auto-add in sequence on the same set, so a caller
  // that sent only context-management still gets interleaved appended.
  const ctx = invocation(
    {
      model: 'claude-test',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 1024 },
    },
    ['context-management-2025-06-27'],
  );

  await withAnthropicBetaHeaderFiltered(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['anthropic-beta'], 'context-management-2025-06-27,interleaved-thinking-2025-05-14');
});

test('does not auto-add interleaved-thinking when caller sent no header and thinking is adaptive', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { type: 'adaptive', budget_tokens: 1024 },
  });

  await withAnthropicBetaHeaderFiltered(ctx, stubRequest, okEvents);

  assertEquals('anthropic-beta' in ctx.headers, false);
});

test('does not set the header when the inbound caller header has nothing allow-listed and no auto-add applies', async () => {
  const ctx = invocation(
    { model: 'claude-test', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
    ['unknown-beta-only'],
  );

  await withAnthropicBetaHeaderFiltered(ctx, stubRequest, okEvents);

  assertEquals('anthropic-beta' in ctx.headers, false);
});

test('does not set the header when no anthropic-beta input is present and thinking is not configured', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
  });

  await withAnthropicBetaHeaderFiltered(ctx, stubRequest, okEvents);

  assertEquals('anthropic-beta' in ctx.headers, false);
});
