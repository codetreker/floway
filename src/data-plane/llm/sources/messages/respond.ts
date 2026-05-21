import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { collectMessagesProtocolEventsToResponse } from './events/to-response.ts';
import type { MessagesStreamEventData } from '../../../shared/protocol/messages.ts';
import { type InternalDebugError, toInternalDebugError } from '../../shared/errors/internal-debug-error.ts';
import type { StreamExecuteResult } from '../../shared/errors/result.ts';
import { upstreamErrorToResponse } from '../../shared/errors/upstream-error.ts';
import { type StreamCompletion, writeSSEFrames } from '../../shared/stream/proxy-sse.ts';
import { type ProtocolFrame, sseFrame } from '../../shared/stream/types.ts';
import type { SourceExecutionContext } from '../execute.ts';
import { createSourceStreamState, eventResultMetadata, recordSourcePerformance, recordSourceUsage, rememberSourceFrameUsage, sourceStreamFailed } from '../respond.ts';
import { createMessagesStreamUsageState, tokenUsageFromMessagesFrame, tokenUsageFromMessagesUsage } from '../usage.ts';
import { MESSAGES_MISSING_TERMINAL_MESSAGE } from './events/protocol.ts';
import { messagesProtocolFrameToSSEFrame } from './events/to-sse.ts';

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

export const respondMessages = async (c: Context, result: StreamExecuteResult<MessagesStreamEventData>, wantsStream: boolean, source: SourceExecutionContext): Promise<Response> => {
  if (result.type === 'upstream-error') {
    recordSourcePerformance(source, result.performance, true);
    return upstreamErrorToResponse(result);
  }

  if (result.type === 'internal-error') {
    recordSourcePerformance(source, result.performance, true);
    return internalMessagesErrorResponse(result.status, result.error);
  }

  const state = createSourceStreamState();
  const usageState = createMessagesStreamUsageState();
  const frames = observeMessagesFrames(result.events, state, usageState, wantsStream);

  if (!wantsStream) {
    try {
      const response = await collectMessagesProtocolEventsToResponse(frames);
      const metadata = await eventResultMetadata(result);
      await recordSourceUsage(metadata.modelIdentity, tokenUsageFromMessagesUsage(response.usage), source.recordUsage);
      recordSourcePerformance(source, metadata.performance, state.failed);
      return Response.json(response);
    } catch (error) {
      recordSourcePerformance(source, result.performance, true);
      return internalMessagesErrorResponse(502, toInternalDebugError(error, 'messages'));
    }
  }

  return streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    try {
      completion = await writeSSEFrames(stream, messagesSseFrames(frames, state), {
        keepAlive: { frame: downstreamMessagesPingKeepAliveFrame },
        downstreamAbortController: source.downstreamAbortController,
      });
    } finally {
      const metadata = await eventResultMetadata(result);
      try {
        await recordSourceUsage(metadata.modelIdentity, state.usage, source.recordUsage);
      } finally {
        recordSourcePerformance(source, metadata.performance, sourceStreamFailed(completion, state));
      }
    }
  });
};
