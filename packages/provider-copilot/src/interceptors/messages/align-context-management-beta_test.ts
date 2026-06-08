import { test } from 'vitest';

import { withContextManagementBetaAligned } from './align-context-management-beta.ts';
import type { MessagesBoundaryCtx } from './types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubUpstreamModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: MessagesPayload & { context_management?: unknown }, headers: Record<string, string> = {}): MessagesBoundaryCtx => ({
  payload: payload as MessagesPayload,
  headers,
  model: stubUpstreamModel({ endpoints: { messages: {} } }),
});

const baseBody = {
  model: 'claude-test',
  max_tokens: 10,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

test('attaches the beta token when the payload has context_management and the header is missing', async () => {
  const ctx = invocation({ ...baseBody, context_management: { edits: [] } });

  await withContextManagementBetaAligned(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['anthropic-beta'], 'context-management-2025-06-27');
});

test('appends the beta token alongside other allow-listed values', async () => {
  const ctx = invocation(
    { ...baseBody, context_management: { edits: [] } },
    { 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
  );

  await withContextManagementBetaAligned(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['anthropic-beta'], 'interleaved-thinking-2025-05-14,context-management-2025-06-27');
});

test('leaves the header untouched when the beta token is already present', async () => {
  const ctx = invocation(
    { ...baseBody, context_management: { edits: [] } },
    { 'anthropic-beta': 'interleaved-thinking-2025-05-14,context-management-2025-06-27' },
  );

  await withContextManagementBetaAligned(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['anthropic-beta'], 'interleaved-thinking-2025-05-14,context-management-2025-06-27');
});

test('does not duplicate the beta token when surrounding whitespace differs', async () => {
  const ctx = invocation(
    { ...baseBody, context_management: { edits: [] } },
    { 'anthropic-beta': ' context-management-2025-06-27 , interleaved-thinking-2025-05-14 ' },
  );

  await withContextManagementBetaAligned(ctx, stubRequest, okEvents);

  // Token is already present (post-trim); leave the caller's exact header
  // formatting untouched so we don't perturb headers we have no reason to
  // rewrite.
  assertEquals(ctx.headers['anthropic-beta'], ' context-management-2025-06-27 , interleaved-thinking-2025-05-14 ');
});

test('does not modify the header when the payload does not carry context_management', async () => {
  const ctx = invocation(baseBody, { 'anthropic-beta': 'interleaved-thinking-2025-05-14' });

  await withContextManagementBetaAligned(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers['anthropic-beta'], 'interleaved-thinking-2025-05-14');
});

test('does not introduce the header when the payload does not carry context_management and no header was set', async () => {
  const ctx = invocation(baseBody);

  await withContextManagementBetaAligned(ctx, stubRequest, okEvents);

  assertEquals('anthropic-beta' in ctx.headers, false);
});
