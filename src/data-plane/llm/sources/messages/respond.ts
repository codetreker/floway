import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { MESSAGES_MISSING_TERMINAL_MESSAGE } from './events/protocol.ts';
import { collectMessagesProtocolEventsToResponse } from './events/to-response.ts';
import { messagesProtocolFrameToSSEFrame } from './events/to-sse.ts';
import type { MessagesStreamEventData } from '../../../shared/protocol/messages.ts';
import type { PerformanceTelemetryContext } from '../../../shared/telemetry/performance.ts';
import type { RequestContext } from '../../interceptors.ts';
import { type InternalDebugError, toInternalDebugError } from '../../shared/errors/internal-debug-error.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import { upstreamErrorToResponse } from '../../shared/errors/upstream-error.ts';
import { type StreamCompletion, writeSSEFrames } from '../../shared/stream/proxy-sse.ts';
import { type ProtocolFrame, sseFrame } from '../../shared/stream/types.ts';
import { createSourceStreamState, eventResultMetadata, recordSourcePerformance, recordSourceUsage, rememberSourceFrameUsage, sourceStreamFailed } from '../respond.ts';
import { createMessagesStreamUsageState, tokenUsageFromMessagesFrame, tokenUsageFromMessagesUsage } from '../usage.ts';

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

const downstreamMessagesPingKeepAliveFrame = sseFrame(JSON.stringify({ type: 'ping' }), 'ping');

const internalMessagesErrorResponse = (status: number, error: InternalDebugError): Response => Response.json(internalMessagesErrorPayload(error), { status });

const internalMessagesStreamErrorFrame = (error: unknown) => sseFrame(JSON.stringify(internalMessagesErrorPayload(toInternalDebugError(error, 'messages'))), 'error');

const isMessagesFailureFrame = (frame: ProtocolFrame<MessagesStreamEventData>) => frame.type === 'event' && frame.event.type === 'error';

const isMessagesTerminalFrame = (frame: ProtocolFrame<MessagesStreamEventData>) => frame.type === 'event' && (frame.event.type === 'message_stop' || frame.event.type === 'error');

const observeMessagesFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>,
  state: ReturnType<typeof createSourceStreamState>,
  usageState: ReturnType<typeof createMessagesStreamUsageState>,
  observeUsage: boolean,
) {
  for await (const frame of frames) {
    const failed = isMessagesFailureFrame(frame);
    if (failed) state.failed = true;
    if (observeUsage) {
      rememberSourceFrameUsage(state, tokenUsageFromMessagesFrame(frame, usageState));
    }
    if (isMessagesTerminalFrame(frame) && !failed) state.completed = true;
    yield frame;
    if (isMessagesTerminalFrame(frame)) return;
  }
  throw new Error(MESSAGES_MISSING_TERMINAL_MESSAGE);
};

const messagesSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>, state: ReturnType<typeof createSourceStreamState>) {
  try {
    for await (const frame of frames) {
      const sse = messagesProtocolFrameToSSEFrame(frame);
      if (sse) yield sse;
    }
  } catch (error) {
    state.failed = true;
    yield internalMessagesStreamErrorFrame(error);
  }
};

export const respondMessages = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<MessagesStreamEventData>>,
  wantsStream: boolean,
  request: RequestContext,
  lastPerformance: PerformanceTelemetryContext | undefined,
  downstreamAbortController: AbortController | undefined,
): Promise<Response> => {
  if (result.type === 'upstream-error') {
    recordSourcePerformance(request, result.performance ?? lastPerformance, true);
    return upstreamErrorToResponse(result);
  }

  if (result.type === 'internal-error') {
    recordSourcePerformance(request, result.performance ?? lastPerformance, true);
    return internalMessagesErrorResponse(result.status, result.error);
  }

  const state = createSourceStreamState();
  const usageState = createMessagesStreamUsageState();
  const frames = observeMessagesFrames(result.events, state, usageState, wantsStream);

  if (!wantsStream) {
    try {
      const response = await collectMessagesProtocolEventsToResponse(frames);
      const metadata = await eventResultMetadata(result);
      await recordSourceUsage(metadata.modelIdentity, tokenUsageFromMessagesUsage(response.usage), request.recordUsage);
      recordSourcePerformance(request, metadata.performance, state.failed);
      return Response.json(response);
    } catch (error) {
      recordSourcePerformance(request, result.performance ?? lastPerformance, true);
      return internalMessagesErrorResponse(502, toInternalDebugError(error, 'messages'));
    }
  }

  return streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    try {
      completion = await writeSSEFrames(stream, messagesSseFrames(frames, state), {
        keepAlive: { frame: downstreamMessagesPingKeepAliveFrame },
        downstreamAbortController,
      });
    } finally {
      const metadata = await eventResultMetadata(result);
      try {
        await recordSourceUsage(metadata.modelIdentity, state.usage, request.recordUsage);
      } finally {
        recordSourcePerformance(request, metadata.performance, sourceStreamFailed(completion, state));
      }
    }
  });
};
