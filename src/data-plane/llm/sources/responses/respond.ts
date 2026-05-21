import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { collectResponsesProtocolEventsToResult } from './events/reassemble.ts';
import { responsesProtocolFrameToSSEFrame } from './events/to-sse.ts';
import type { PerformanceTelemetryContext } from '../../../shared/telemetry/performance.ts';
import type { RequestContext } from '../../interceptors.ts';
import { type InternalDebugError, toInternalDebugError } from '../../shared/errors/internal-debug-error.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import { upstreamErrorToResponse } from '../../shared/errors/upstream-error.ts';
import type { ResponsesStreamEvent } from '../../shared/protocol/responses.ts';
import { isResponsesTerminalEvent, RESPONSES_MISSING_TERMINAL_MESSAGE } from '../../shared/protocol/responses.ts';
import { type StreamCompletion, writeSSEFrames } from '../../shared/stream/proxy-sse.ts';
import { type ProtocolFrame, sseCommentFrame, sseFrame } from '../../shared/stream/types.ts';
import { createSourceStreamState, eventResultMetadata, recordSourcePerformance, recordSourceUsage, rememberSourceFrameUsage, sourceStreamFailed } from '../respond.ts';
import { tokenUsageFromResponsesFrame, tokenUsageFromResponsesResult } from '../usage.ts';

const internalResponsesErrorPayload = (error: InternalDebugError) => ({
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

const internalResponsesErrorResponse = (status: number, error: InternalDebugError): Response => Response.json(internalResponsesErrorPayload(error), { status });

const internalResponsesStreamErrorFrame = (error: unknown) => {
  const debug = toInternalDebugError(error, 'responses');
  return sseFrame(
    JSON.stringify({
      type: 'error',
      message: debug.message,
      code: debug.type,
      name: debug.name,
      stack: debug.stack,
      cause: debug.cause,
      source_api: debug.source_api,
      target_api: debug.target_api,
    }),
    'error',
  );
};

const isResponsesFailureFrame = (frame: ProtocolFrame<ResponsesStreamEvent>) => frame.type === 'event' && (frame.event.type === 'error' || frame.event.type === 'response.failed');

const isResponsesTerminalFrame = (frame: ProtocolFrame<ResponsesStreamEvent>) => frame.type === 'event' && isResponsesTerminalEvent(frame.event);

const observeResponsesFrames = async function* (frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>, state: ReturnType<typeof createSourceStreamState>, observeUsage: boolean) {
  for await (const frame of frames) {
    const failed = isResponsesFailureFrame(frame);
    if (failed) state.failed = true;
    if (observeUsage) {
      rememberSourceFrameUsage(state, tokenUsageFromResponsesFrame(frame));
    }
    if (isResponsesTerminalFrame(frame) && !failed) state.completed = true;
    yield frame;
    if (isResponsesTerminalFrame(frame)) return;
  }
  throw new Error(RESPONSES_MISSING_TERMINAL_MESSAGE);
};

const responsesSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>, state: ReturnType<typeof createSourceStreamState>) {
  try {
    for await (const frame of frames) {
      const sse = responsesProtocolFrameToSSEFrame(frame);
      if (sse) yield sse;
    }
  } catch (error) {
    state.failed = true;
    yield internalResponsesStreamErrorFrame(error);
  }
};

export const respondResponses = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>,
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
    return internalResponsesErrorResponse(result.status, result.error);
  }

  const state = createSourceStreamState();
  const frames = observeResponsesFrames(result.events, state, wantsStream);

  if (!wantsStream) {
    try {
      const response = await collectResponsesProtocolEventsToResult(frames);
      const metadata = await eventResultMetadata(result);
      await recordSourceUsage(metadata.modelIdentity, tokenUsageFromResponsesResult(response), request.recordUsage);
      recordSourcePerformance(request, metadata.performance, state.failed || response.status === 'failed');
      return Response.json(response);
    } catch (error) {
      recordSourcePerformance(request, result.performance ?? lastPerformance, true);
      return internalResponsesErrorResponse(502, toInternalDebugError(error, 'responses'));
    }
  }

  return streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    try {
      completion = await writeSSEFrames(stream, responsesSseFrames(frames, state), {
        keepAlive: { frame: sseCommentFrame('keepalive') },
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
