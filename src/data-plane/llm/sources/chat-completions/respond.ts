import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { CHAT_COMPLETIONS_MISSING_DONE_MESSAGE } from './events/protocol.ts';
import { collectChatProtocolEventsToCompletion } from './events/reassemble.ts';
import { chatProtocolFrameToSSEFrame } from './events/to-sse.ts';
import { chatCompletionsErrorPayloadMessage } from '../../../shared/protocol/chat-completions-errors.ts';
import type { ChatCompletionChunk } from '../../../shared/protocol/chat-completions.ts';
import type { PerformanceTelemetryContext } from '../../../shared/telemetry/performance.ts';
import type { RequestContext } from '../../interceptors.ts';
import { type InternalDebugError, toInternalDebugError } from '../../shared/errors/internal-debug-error.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import { upstreamErrorToResponse } from '../../shared/errors/upstream-error.ts';
import { type StreamCompletion, writeSSEFrames } from '../../shared/stream/proxy-sse.ts';
import { type ProtocolFrame, sseCommentFrame, sseFrame } from '../../shared/stream/types.ts';
import { createSourceStreamState, eventResultMetadata, recordSourcePerformance, recordSourceUsage, rememberSourceFrameUsage, sourceStreamFailed } from '../respond.ts';
import { tokenUsageFromChatFrame, tokenUsageFromChatUsage } from '../usage.ts';

const internalChatErrorPayload = (error: InternalDebugError) => ({
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

const internalChatErrorResponse = (status: number, error: InternalDebugError): Response => Response.json(internalChatErrorPayload(error), { status });

const internalChatStreamErrorFrame = (error: unknown) => sseFrame(JSON.stringify(internalChatErrorPayload(toInternalDebugError(error, 'chat-completions'))), 'error');

const isChatFailureFrame = (frame: ProtocolFrame<ChatCompletionChunk>) => frame.type === 'event' && chatCompletionsErrorPayloadMessage(frame.event) !== null;

const chatTerminalFrame = (frame: ProtocolFrame<ChatCompletionChunk>) => frame.type === 'done' || isChatFailureFrame(frame);

const observeChatFrames = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>, state: ReturnType<typeof createSourceStreamState>, observeUsage: boolean) {
  for await (const frame of frames) {
    const failed = isChatFailureFrame(frame);
    if (failed) state.failed = true;
    if (frame.type === 'done' || observeUsage) {
      rememberSourceFrameUsage(state, tokenUsageFromChatFrame(frame));
    }
    if (chatTerminalFrame(frame) && !failed) state.completed = true;
    yield frame;
    if (chatTerminalFrame(frame)) return;
  }
  throw new Error(CHAT_COMPLETIONS_MISSING_DONE_MESSAGE);
};

const chatSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>, includeUsageChunk: boolean, state: ReturnType<typeof createSourceStreamState>) {
  try {
    for await (const frame of frames) {
      const sse = chatProtocolFrameToSSEFrame(frame, { includeUsageChunk });
      if (sse) yield sse;
    }
  } catch (error) {
    state.failed = true;
    yield internalChatStreamErrorFrame(error);
  }
};

export const respondChatCompletions = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<ChatCompletionChunk>>,
  wantsStream: boolean,
  includeUsageChunk: boolean,
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
    return internalChatErrorResponse(result.status, result.error);
  }

  const state = createSourceStreamState();
  const frames = observeChatFrames(result.events, state, wantsStream);

  if (!wantsStream) {
    try {
      const response = await collectChatProtocolEventsToCompletion(frames);
      const metadata = await eventResultMetadata(result);
      const usage = response.usage ? tokenUsageFromChatUsage(response.usage) : null;
      await recordSourceUsage(metadata.modelIdentity, usage, request.recordUsage);
      recordSourcePerformance(request, metadata.performance, state.failed);
      return Response.json(response);
    } catch (error) {
      recordSourcePerformance(request, result.performance ?? lastPerformance, true);
      return internalChatErrorResponse(502, toInternalDebugError(error, 'chat-completions'));
    }
  }

  return streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    try {
      completion = await writeSSEFrames(stream, chatSseFrames(frames, includeUsageChunk, state), {
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
