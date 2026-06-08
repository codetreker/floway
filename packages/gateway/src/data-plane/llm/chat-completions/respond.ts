import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE, collectChatCompletionsProtocolEventsToResult } from './events/to-result.ts';
import { chatCompletionsProtocolFrameToSSEFrame } from './events/to-sse.ts';
import { tokenUsage } from '../../shared/telemetry/usage.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { SourceStreamState, eventResultMetadata, plainResultToResponse, recordPerformance, recordUsage } from '../shared/respond.ts';
import { type StreamCompletion, writeSSEFrames } from '../shared/stream/sse.ts';
import type { ChatCompletionsStreamEvent, ChatCompletionsResult } from '@floway-dev/protocols/chat-completions';
import { chatCompletionsErrorPayloadMessage } from '@floway-dev/protocols/chat-completions';
import { type ProtocolFrame, sseCommentFrame, sseFrame } from '@floway-dev/protocols/common';
import { type ExecuteResult, type PlainResult, type InternalDebugError, toInternalDebugError } from '@floway-dev/provider';
import { upstreamErrorToResponse } from '@floway-dev/provider';

// Renders an upstream Chat Completions result into the client HTTP/SSE
// response. An error-typed result is a pre-stream failure and always answers as
// HTTP; an events result drains to one JSON body (non-streaming) or is proxied
// frame by frame (streaming). `success` reports whether a non-streaming body was
// produced, so the orchestrator knows whether to flush stored items.
export const respondChatCompletions = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>> | PlainResult,
  wantsStream: boolean,
  includeUsageChunk: boolean,
  ctx: GatewayCtx,
): Promise<{ success: boolean; response: Response }> => {
  if (result.type === 'upstream-error') {
    recordPerformance(ctx, result.performance, true);
    return { success: false, response: upstreamErrorToResponse(result) };
  }

  if (result.type === 'internal-error') {
    recordPerformance(ctx, result.performance, true);
    return { success: false, response: internalChatCompletionsErrorResponse(result.status, result.error) };
  }

  if (result.type === 'plain') return { success: true, response: plainResultToResponse(result) };

  const state = new SourceStreamState();
  const frames = observeChatCompletionsFrames(result.events, state, wantsStream);

  if (!wantsStream) {
    try {
      const response = await collectChatCompletionsProtocolEventsToResult(frames);
      const metadata = await eventResultMetadata(result);
      const usage = response.usage ? tokenUsageFromChatCompletionsUsage(response.usage) : null;
      await recordUsage(ctx, metadata.modelIdentity, usage);
      recordPerformance(ctx, metadata.performance, state.failed);
      return { success: true, response: Response.json(response) };
    } catch (error) {
      recordPerformance(ctx, result.performance, true);
      return { success: false, response: internalChatCompletionsErrorResponse(502, toInternalDebugError(error, 'chat-completions')) };
    }
  }

  const response = streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    try {
      completion = await writeSSEFrames(stream, chatCompletionsSseFrames(frames, includeUsageChunk, state), {
        keepAlive: { frame: sseCommentFrame('keepalive') },
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

// --- token usage ---

// OpenAI Chat usage reports prompt_tokens inclusive of cached and
// cache-creation tokens; subtract them to recover the disjoint bare input.
const tokenUsageFromChatCompletionsUsage = (u: NonNullable<ChatCompletionsResult['usage']>) => {
  const cacheRead = u.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = u.prompt_tokens_details?.cache_creation_input_tokens ?? 0;
  return tokenUsage({
    input: u.prompt_tokens - cacheRead - cacheWrite,
    input_cache_read: cacheRead,
    input_cache_write: cacheWrite,
    output: u.completion_tokens,
  });
};

// --- error rendering ---

const internalChatCompletionsErrorPayload = (error: InternalDebugError) => ({
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

const internalChatCompletionsErrorResponse = (status: number, error: InternalDebugError): Response => Response.json(internalChatCompletionsErrorPayload(error), { status });

// --- frame observation ---

const isChatCompletionsFailureFrame = (frame: ProtocolFrame<ChatCompletionsStreamEvent>) => frame.type === 'event' && chatCompletionsErrorPayloadMessage(frame.event) !== null;

const isChatCompletionsTerminalFrame = (frame: ProtocolFrame<ChatCompletionsStreamEvent>) => frame.type === 'done' || isChatCompletionsFailureFrame(frame);

const observeChatCompletionsFrames = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>, state: SourceStreamState, observeUsage: boolean) {
  for await (const frame of frames) {
    const failed = isChatCompletionsFailureFrame(frame);
    if (failed) state.failed = true;
    if (observeUsage) {
      state.rememberUsage(frame.type === 'event' && Array.isArray(frame.event.choices) && frame.event.choices.length === 0 && frame.event.usage ? tokenUsageFromChatCompletionsUsage(frame.event.usage) : null);
    }
    if (isChatCompletionsTerminalFrame(frame) && !failed) state.completed = true;
    yield frame;
    if (isChatCompletionsTerminalFrame(frame)) return;
  }
  throw new Error(CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE);
};

const chatCompletionsSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>, includeUsageChunk: boolean, state: SourceStreamState) {
  try {
    for await (const frame of frames) {
      const sse = chatCompletionsProtocolFrameToSSEFrame(frame, { includeUsageChunk });
      if (sse) yield sse;
    }
  } catch (error) {
    state.failed = true;
    yield sseFrame(JSON.stringify(internalChatCompletionsErrorPayload(toInternalDebugError(error, 'chat-completions'))), 'error');
  }
};
