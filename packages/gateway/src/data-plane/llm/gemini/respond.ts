import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { geminiStatusForHttpStatus } from './errors.ts';
import { GEMINI_MISSING_TERMINAL_MESSAGE, isGeminiErrorEvent, isGeminiTerminalEvent, collectGeminiProtocolEventsToResult } from './events/to-result.ts';
import { geminiProtocolFrameToSSEFrame } from './events/to-sse.ts';
import { tokenUsage } from '../../shared/telemetry/usage.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { SourceStreamState, eventResultMetadata, plainResultToResponse, recordPerformance, recordUsage } from '../shared/respond.ts';
import { type StreamCompletion, writeSSEFrames } from '../shared/stream/sse.ts';
import { type ProtocolFrame, sseCommentFrame, sseFrame } from '@floway-dev/protocols/common';
import type { GeminiErrorResponse, GeminiResult, GeminiStreamEvent, GeminiUsageMetadata } from '@floway-dev/protocols/gemini';
import { type ExecuteResult, type PlainResult, type UpstreamErrorResult, type InternalDebugError, toInternalDebugError, decodeUpstreamErrorBody } from '@floway-dev/provider';

// Renders an upstream Gemini result into the client HTTP/SSE response, in the
// Google-RPC error envelope. An error-typed result is a pre-stream failure and
// always answers as HTTP; an events result drains to one JSON body
// (non-streaming) or is proxied frame by frame (streaming). `success` reports
// whether a non-streaming body was produced, so the orchestrator knows whether
// to flush stored items.
export const respondGemini = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<GeminiStreamEvent>> | PlainResult,
  wantsStream: boolean,
  ctx: GatewayCtx,
): Promise<{ success: boolean; response: Response }> => {
  if (result.type === 'upstream-error') {
    recordPerformance(ctx, result.performance, true);
    return { success: false, response: geminiUpstreamErrorResponse(result) };
  }

  if (result.type === 'internal-error') {
    recordPerformance(ctx, result.performance, true);
    return { success: false, response: geminiErrorResponse(result.status, result.error.message, internalDebugFields(result.error)) };
  }

  if (result.type === 'plain') return { success: true, response: plainResultToResponse(result) };

  const state = new SourceStreamState();
  const frames = observeGeminiFrames(result.events, state, wantsStream);

  if (!wantsStream) {
    try {
      const response = await collectGeminiProtocolEventsToResult(frames);
      const metadata = await eventResultMetadata(result);
      await recordUsage(ctx, metadata.modelIdentity, tokenUsageFromGeminiResponse(response));
      recordPerformance(ctx, metadata.performance, state.failed);
      return { success: true, response: Response.json(response) };
    } catch (error) {
      recordPerformance(ctx, result.performance, true);
      return { success: false, response: geminiCollectErrorResponse(error) };
    }
  }

  const response = streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    try {
      completion = await writeSSEFrames(stream, geminiSseFrames(frames, state), {
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

// Gemini reports promptTokenCount inclusive of cachedContentTokenCount
// (verified against the Google GenAI SDK docs); subtract it for disjoint input.
// Reasoning (thoughts) tokens are billed as output.
const tokenUsageFromGeminiUsageMetadata = (m: GeminiUsageMetadata) => {
  const cacheRead = m.cachedContentTokenCount ?? 0;
  return tokenUsage({
    input: (m.promptTokenCount ?? 0) - cacheRead,
    input_cache_read: cacheRead,
    output: (m.candidatesTokenCount ?? 0) + (m.thoughtsTokenCount ?? 0),
  });
};

const tokenUsageFromGeminiResponse = (r: GeminiResult) => (r.usageMetadata ? tokenUsageFromGeminiUsageMetadata(r.usageMetadata) : null);

// --- error rendering: Google-RPC envelope ---

type GeminiErrorDebugFields = Partial<Pick<InternalDebugError, 'type' | 'name' | 'stack' | 'cause'>> & { source_api?: string; target_api?: string };

type GeminiErrorStatusPayload = {
  error: GeminiErrorResponse['error'] & GeminiErrorDebugFields;
};

// HTTP status -> Google RPC status string mapping plus the two ways we coerce
// an out-of-range code: `googleRpcHttpStatusCode` for passthrough/native
// errors (anything insane becomes 500), `synthesizedGeminiHttpStatusCode` for
// errors we mint (a non-500 that maps to INTERNAL becomes 500).
const synthesizedGeminiHttpStatusCode = (status: number): number => (geminiStatusForHttpStatus(status) === 'INTERNAL' && status !== 500 ? 500 : status);

const googleRpcHttpStatusCode = (status: number): number => (Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500);

const geminiRpcErrorPayload = (status: number, message: string, debug: GeminiErrorDebugFields = {}): GeminiErrorStatusPayload => {
  const code = googleRpcHttpStatusCode(status);
  return {
    error: { code, message, status: geminiStatusForHttpStatus(code), ...debug },
  };
};

const internalDebugFields = (error: InternalDebugError): GeminiErrorDebugFields => ({
  type: error.type,
  name: error.name,
  stack: error.stack,
  cause: error.cause,
  source_api: error.source_api,
  ...(error.target_api ? { target_api: error.target_api } : {}),
});

const geminiInternalRpcErrorPayload = (status: number, error: unknown): GeminiErrorStatusPayload => {
  const debug = toInternalDebugError(error, 'gemini');
  return geminiRpcErrorPayload(status, debug.message, internalDebugFields(debug));
};

// Response builders. The count_tokens path under `http.ts` reuses them
// alongside the error renderer for its synthesized JSON envelope.
export const geminiRpcErrorResponse = (status: number, message: string): Response => {
  const payload = geminiRpcErrorPayload(status, message);
  return Response.json(payload, { status: payload.error.code });
};

export const geminiInternalRpcErrorResponse = (status: number, error: unknown): Response => {
  const payload = geminiInternalRpcErrorPayload(status, error);
  return Response.json(payload, { status: payload.error.code });
};

const geminiErrorResponse = (status: number, message: string, debug: GeminiErrorDebugFields = {}): Response => {
  const code = synthesizedGeminiHttpStatusCode(status);
  return Response.json({ error: { code, message, status: geminiStatusForHttpStatus(code), ...debug } }, { status: code });
};

const geminiUpstreamErrorResponse = (error: UpstreamErrorResult): Response => upstreamGoogleRpcErrorResponse(error) ?? geminiErrorResponse(error.status, upstreamErrorMessage(error));

const geminiCollectErrorResponse = (error: unknown): Response => {
  const geminiError = caughtGeminiErrorEvent(error);
  return geminiError ? Response.json(geminiError, { status: googleRpcHttpStatusCode(geminiError.error.code) }) : geminiInternalRpcErrorResponse(502, error);
};

// Recognizing / extracting an upstream-shaped Gemini error from a raw body or a
// thrown cause, so a native Google error is forwarded verbatim rather than
// re-wrapped.
const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const isGeminiErrorResponse = (value: unknown): value is GeminiErrorResponse => {
  if (!value || typeof value !== 'object' || !('error' in value)) return false;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return false;
  const payload = error as Partial<GeminiErrorResponse['error']>;
  return typeof payload.code === 'number' && typeof payload.message === 'string' && typeof payload.status === 'string';
};

const upstreamGoogleRpcErrorResponse = (error: UpstreamErrorResult): Response | null => {
  const parsed = parseJson(decodeUpstreamErrorBody(error).trim());
  if (!isGeminiErrorResponse(parsed)) return null;

  return new Response(error.body.slice(), {
    status: googleRpcHttpStatusCode(parsed.error.code),
    headers: new Headers(error.headers),
  });
};

const upstreamErrorMessage = (error: UpstreamErrorResult): string => {
  const body = decodeUpstreamErrorBody(error).trim();
  return body || 'Upstream Gemini request failed.';
};

const caughtGeminiErrorEvent = (error: unknown): GeminiErrorResponse | null => {
  if (!(error instanceof Error)) return null;
  return isGeminiErrorResponse(error.cause) ? error.cause : null;
};

const geminiStreamErrorFrame = (error: unknown) => sseFrame(JSON.stringify(caughtGeminiErrorEvent(error) ?? geminiInternalRpcErrorPayload(500, error)));

// --- frame observation ---

const isGeminiTerminalFrame = (frame: ProtocolFrame<GeminiStreamEvent>): boolean => frame.type === 'done' || (frame.type === 'event' && isGeminiTerminalEvent(frame.event));

const observeGeminiFrames = async function* (frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>, state: SourceStreamState, observeUsage: boolean) {
  for await (const frame of frames) {
    const failed = frame.type === 'event' && isGeminiErrorEvent(frame.event);
    if (failed) state.failed = true;
    if (observeUsage) {
      state.rememberUsage(frame.type === 'event' && !('error' in frame.event) ? tokenUsageFromGeminiResponse(frame.event) : null);
    }
    if (isGeminiTerminalFrame(frame) && !failed) state.completed = true;
    yield frame;
    if (isGeminiTerminalFrame(frame)) return;
  }
  throw new Error(GEMINI_MISSING_TERMINAL_MESSAGE);
};

const geminiSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>, state: SourceStreamState) {
  try {
    for await (const frame of frames) {
      const sse = geminiProtocolFrameToSSEFrame(frame);
      if (sse) yield sse;
    }
  } catch (error) {
    state.failed = true;
    yield geminiStreamErrorFrame(error);
  }
};
