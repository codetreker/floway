import type { EmitInput } from './emit-types.ts';
import type { PerformanceApiName, TelemetryModelIdentity } from '../../../repo/types.ts';
import { chatCompletionsErrorPayloadMessage } from '../../shared/protocol/chat-completions-errors.ts';
import { type PerformanceTelemetryContext, recordPerformanceError, recordPerformanceLatency } from '../../shared/telemetry/performance.ts';
import type { SseFrame, StreamFrame } from '../shared/stream/types.ts';

type TerminalKind = 'success' | 'failure';

export function withUpstreamTelemetry<T>(
  events: AsyncIterable<T>,
  input: EmitInput<{ model: string; stream?: boolean | null }>,
  targetApi: PerformanceApiName,
  startedAt: number,
  modelIdentity: TelemetryModelIdentity,
): AsyncIterable<T> {
  return (async function* () {
    let recorded = false;
    const recordOnce = (kind: TerminalKind, durationMs: number) => {
      if (recorded || !input.apiKeyId) return;
      recorded = true;
      const context = upstreamContext(input, targetApi, modelIdentity);
      const promise = kind === 'success' ? recordPerformanceLatency(context, 'upstream_success', durationMs) : recordPerformanceError(context, 'upstream_success');
      input.scheduleBackground ? input.scheduleBackground(promise) : void promise;
    };

    // Track whether the upstream iterator itself reached an end state (EOF or
    // threw). The outer finally needs this so it can distinguish:
    //   * upstream ended without a terminal frame  -> record as failure
    //   * downstream consumer cancelled mid-stream -> do not record anything
    // Async generators don't expose the reason their body unwinds, so we set
    // this flag explicitly only on natural loop exit / upstream throw.
    let upstreamEnded = false;
    try {
      try {
        for await (const event of events) {
          const terminal = classifyTerminalFrame(event, targetApi);
          const terminalDurationMs = terminal ? performance.now() - startedAt : 0;
          try {
            yield event;
          } finally {
            // Source protocol collectors stop at terminal events and may never
            // pull the upstream iterator to EOF, so record once a target-owned
            // terminal marker has been delivered downstream.
            if (terminal) recordOnce(terminal, terminalDurationMs);
          }
        }
        upstreamEnded = true;
      } catch (error) {
        upstreamEnded = true;
        throw error;
      }
    } finally {
      // EOF without any terminal frame, or an upstream-thrown error mid-stream,
      // means upstream failed to produce a complete response. Client-initiated
      // cancel may now also reach the upstream reader via AbortSignal; that can
      // make the wrapped iterator end as EOF, so keep it out of upstream health.
      if (!recorded && upstreamEnded && input.downstreamAbortSignal?.aborted !== true) {
        recordOnce('failure', performance.now() - startedAt);
      }
    }
  })();
}

export function recordUpstreamHttpFailure(input: EmitInput<{ model: string; stream?: boolean | null }>, targetApi: PerformanceApiName, modelIdentity: TelemetryModelIdentity): void {
  if (!input.apiKeyId) return;
  const promise = recordPerformanceError(upstreamContext(input, targetApi, modelIdentity), 'upstream_success');
  input.scheduleBackground ? input.scheduleBackground(promise) : void promise;
}

export function targetPerformanceContext(
  input: EmitInput<{ model: string; stream?: boolean | null }>,
  targetApi: PerformanceApiName,
  modelIdentity: TelemetryModelIdentity,
): PerformanceTelemetryContext {
  return upstreamContext(input, targetApi, modelIdentity);
}

function classifyTerminalFrame(value: unknown, targetApi: PerformanceApiName): TerminalKind | null {
  if (!isStreamFrame(value)) return null;
  if (value.type === 'json') {
    return classifyJsonTerminal(value.data, targetApi);
  }
  return classifySseTerminal(value, targetApi);
}

function classifyJsonTerminal(data: unknown, targetApi: PerformanceApiName): TerminalKind | null {
  if (targetApi === 'responses') {
    const status = (data as { status?: unknown }).status;
    if (status === 'failed') return 'failure';
    return 'success';
  }
  if (targetApi === 'messages') {
    const type = (data as { type?: unknown }).type;
    if (type === 'error') return 'failure';
    return 'success';
  }
  return chatCompletionsErrorPayloadMessage(data) ? 'failure' : 'success';
}

function isStreamFrame(value: unknown): value is StreamFrame<unknown> {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  if (type === 'json') return true;
  return type === 'sse' && typeof (value as { data?: unknown }).data === 'string';
}

function classifySseTerminal(frame: SseFrame, targetApi: PerformanceApiName): TerminalKind | null {
  const data = frame.data.trim();
  if (data === '[DONE]') {
    return targetApi === 'chat-completions' ? 'success' : null;
  }

  let parsed: { type?: unknown; status?: unknown } | null = null;
  try {
    parsed = JSON.parse(data) as { type?: unknown; status?: unknown };
  } catch {
    return null;
  }

  let eventType = frame.event;
  if (typeof parsed.type === 'string') eventType = parsed.type;

  if (targetApi === 'messages') {
    if (eventType === 'message_stop') return 'success';
    if (eventType === 'error') return 'failure';
    return null;
  }
  if (targetApi === 'responses') {
    if (eventType === 'response.completed' || eventType === 'response.incomplete') return 'success';
    if (eventType === 'response.failed') return 'failure';
    if (parsed.status === 'failed') return 'failure';
    return null;
  }
  if (chatCompletionsErrorPayloadMessage(parsed)) return 'failure';
  return null;
}

function upstreamContext(input: EmitInput<{ model: string; stream?: boolean | null }>, targetApi: PerformanceApiName, modelIdentity: TelemetryModelIdentity): PerformanceTelemetryContext {
  return {
    keyId: input.apiKeyId ?? 'unknown',
    model: modelIdentity.model,
    upstream: modelIdentity.upstream,
    modelKey: modelIdentity.modelKey,
    sourceApi: input.sourceApi,
    targetApi,
    stream: input.clientStream ?? input.payload.stream === true,
    runtimeLocation: input.runtimeLocation ?? 'unknown',
  };
}
