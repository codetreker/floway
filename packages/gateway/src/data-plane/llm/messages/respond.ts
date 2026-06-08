import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { MESSAGES_MISSING_TERMINAL_MESSAGE, collectMessagesProtocolEventsToResult } from './events/to-result.ts';
import { messagesProtocolFrameToSSEFrame } from './events/to-sse.ts';
import { tokenUsage } from '../../shared/telemetry/usage.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { SourceStreamState, eventResultMetadata, plainResultToResponse, recordPerformance, recordUsage } from '../shared/respond.ts';
import { type StreamCompletion, writeSSEFrames } from '../shared/stream/sse.ts';
import { type ProtocolFrame, sseFrame } from '@floway-dev/protocols/common';
import type { MessagesMessageDeltaEvent, MessagesStreamEvent, MessagesUsage } from '@floway-dev/protocols/messages';
import { type ExecuteResult, type PlainResult, type InternalDebugError, toInternalDebugError } from '@floway-dev/provider';
import { upstreamErrorToResponse } from '@floway-dev/provider';

type MessagesUsageLike = MessagesUsage | NonNullable<MessagesMessageDeltaEvent['usage']>;

// Renders an upstream Messages result into the client HTTP/SSE response. An
// error-typed result is a pre-stream failure and always answers as HTTP; an
// events result drains to one JSON body (non-streaming) or is proxied frame by
// frame (streaming). `success` reports whether a non-streaming body was
// produced, so the orchestrator knows whether to flush stored items.
export const respondMessages = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<MessagesStreamEvent>> | PlainResult,
  wantsStream: boolean,
  ctx: GatewayCtx,
): Promise<{ success: boolean; response: Response }> => {
  if (result.type === 'upstream-error') {
    recordPerformance(ctx, result.performance, true);
    return { success: false, response: upstreamErrorToResponse(result) };
  }

  if (result.type === 'internal-error') {
    recordPerformance(ctx, result.performance, true);
    return { success: false, response: internalMessagesErrorResponse(result.status, result.error) };
  }

  if (result.type === 'plain') return { success: true, response: plainResultToResponse(result) };

  const state = new SourceStreamState();
  const usageState = createMessagesStreamUsageState();
  const frames = observeMessagesFrames(result.events, state, usageState, wantsStream);

  if (!wantsStream) {
    try {
      const response = await collectMessagesProtocolEventsToResult(frames);
      const metadata = await eventResultMetadata(result);
      await recordUsage(ctx, metadata.modelIdentity, tokenUsageFromMessagesUsage(response.usage));
      recordPerformance(ctx, metadata.performance, state.failed);
      return { success: true, response: Response.json(response) };
    } catch (error) {
      recordPerformance(ctx, result.performance, true);
      return { success: false, response: internalMessagesErrorResponse(502, toInternalDebugError(error, 'messages')) };
    }
  }

  const response = streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    try {
      completion = await writeSSEFrames(stream, messagesSseFrames(frames, state), {
        keepAlive: { frame: sseFrame(JSON.stringify({ type: 'ping' }), 'ping') },
        ...(ctx.downstreamAbortController !== undefined ? { downstreamAbortController: ctx.downstreamAbortController } : {}),
      });
    } finally {
      const metadata = await eventResultMetadata(result);
      try {
        await recordUsage(ctx, metadata.modelIdentity, state.usage);
      } finally {
        recordPerformance(ctx, metadata.performance, state.failedAfter(completion));
      }
    }
  });

  return { success: true, response };
};

// Anthropic already reports disjoint token counts: input_tokens excludes the
// cache figures. Map them straight onto the billing dimensions without summing.
const tokenUsageFromMessagesUsage = (u: MessagesUsageLike) =>
  tokenUsage({
    input: u.input_tokens ?? 0,
    input_cache_read: u.cache_read_input_tokens ?? 0,
    input_cache_write: u.cache_creation_input_tokens ?? 0,
    output: u.output_tokens,
  });

export const createMessagesStreamUsageState = () => ({
  current: tokenUsage({}),
  gotInputFromStart: false,
});

type MessagesStreamUsageState = ReturnType<typeof createMessagesStreamUsageState>;

export const tokenUsageFromMessagesFrame = (frame: ProtocolFrame<MessagesStreamEvent>, state: MessagesStreamUsageState) => {
  if (frame.type !== 'event') return null;
  const { event } = frame;
  if (event.type === 'message_start') {
    state.current = tokenUsageFromMessagesUsage(event.message.usage);
    // A fully cache-hit prompt reports message_start with input=0 but non-zero
    // cache reads; the input accounting still arrived, so the flag must reflect
    // every input-side dimension, not bare input alone — otherwise a later
    // delta carrying input_tokens re-merges and drops the cache counts.
    state.gotInputFromStart ||= (state.current.input ?? 0) + (state.current.input_cache_read ?? 0) + (state.current.input_cache_write ?? 0) > 0;
  }
  if (event.type === 'message_delta' && event.usage) {
    if (!state.gotInputFromStart && event.usage.input_tokens !== undefined) {
      state.current = tokenUsageFromMessagesUsage(event.usage);
    } else state.current.output = event.usage.output_tokens;
  }
  return event.type === 'message_stop' ? state.current : null;
};

const internalMessagesErrorPayload = (error: InternalDebugError) => ({
  type: 'error',
  error: {
    type: error.type,
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause,
    source_api: error.source_api,
    target_api: error.target_api,
  },
});

const internalMessagesErrorResponse = (status: number, error: InternalDebugError): Response => Response.json(internalMessagesErrorPayload(error), { status });

const isMessagesTerminalFrame = (frame: ProtocolFrame<MessagesStreamEvent>) => frame.type === 'event' && (frame.event.type === 'message_stop' || frame.event.type === 'error');

const observeMessagesFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
  state: SourceStreamState,
  usageState: MessagesStreamUsageState,
  observeUsage: boolean,
) {
  for await (const frame of frames) {
    const failed = frame.type === 'event' && frame.event.type === 'error';
    if (failed) state.failed = true;
    if (observeUsage) {
      state.rememberUsage(tokenUsageFromMessagesFrame(frame, usageState));
    }
    if (isMessagesTerminalFrame(frame) && !failed) state.completed = true;
    yield frame;
    if (isMessagesTerminalFrame(frame)) return;
  }
  throw new Error(MESSAGES_MISSING_TERMINAL_MESSAGE);
};

const messagesSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>, state: SourceStreamState) {
  try {
    for await (const frame of frames) {
      const sse = messagesProtocolFrameToSSEFrame(frame);
      if (sse) yield sse;
    }
  } catch (error) {
    state.failed = true;
    yield sseFrame(JSON.stringify(internalMessagesErrorPayload(toInternalDebugError(error, 'messages'))), 'error');
  }
};
