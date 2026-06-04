import { type PerformanceTelemetryContext, recordPerformanceError, recordPerformanceLatency } from '../../shared/telemetry/performance.ts';
import type { Invocation, RequestContext } from '../interceptors.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { PerformanceApiName, TelemetryModelIdentity } from '@floway-dev/provider';

type TerminalKind = 'success' | 'failure';

export function withUpstreamTelemetry<T>(
  events: AsyncIterable<ProtocolFrame<T>>,
  invocation: Invocation<unknown>,
  request: RequestContext,
  targetApi: PerformanceApiName,
  startedAt: number,
  modelIdentity: TelemetryModelIdentity,
): AsyncIterable<ProtocolFrame<T>> {
  return (async function* () {
    let recorded = false;
    const recordOnce = (kind: TerminalKind, durationMs: number) => {
      if (recorded || !request.apiKeyId) return;
      recorded = true;
      const context = targetPerformanceContext(invocation, request, targetApi, modelIdentity);
      const promise = kind === 'success' ? recordPerformanceLatency(context, 'upstream_success', durationMs) : recordPerformanceError(context, 'upstream_success');
      request.scheduleBackground ? request.scheduleBackground(promise) : void promise;
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
        for await (const frame of events) {
          const terminal = classifyTerminalFrame(frame, targetApi);
          const terminalDurationMs = terminal ? performance.now() - startedAt : 0;
          try {
            yield frame;
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
      if (!recorded && upstreamEnded && request.downstreamAbortSignal?.aborted !== true) {
        recordOnce('failure', performance.now() - startedAt);
      }
    }
  })();
}

export function recordUpstreamHttpFailure(invocation: Invocation<unknown>, request: RequestContext, targetApi: PerformanceApiName, modelIdentity: TelemetryModelIdentity): void {
  if (!request.apiKeyId) return;
  const promise = recordPerformanceError(targetPerformanceContext(invocation, request, targetApi, modelIdentity), 'upstream_success');
  request.scheduleBackground ? request.scheduleBackground(promise) : void promise;
}

// Non-streaming endpoints can't be instrumented via withUpstreamTelemetry
// (no frame stream to observe), so they call this directly with the
// already-measured wall-clock duration once the upstream Response is in hand.
export function recordUpstreamLatency(invocation: Invocation<unknown>, request: RequestContext, targetApi: PerformanceApiName, modelIdentity: TelemetryModelIdentity, durationMs: number): void {
  if (!request.apiKeyId) return;
  const promise = recordPerformanceLatency(targetPerformanceContext(invocation, request, targetApi, modelIdentity), 'upstream_success', durationMs);
  request.scheduleBackground ? request.scheduleBackground(promise) : void promise;
}

function classifyTerminalFrame<T>(frame: ProtocolFrame<T>, targetApi: PerformanceApiName): TerminalKind | null {
  if (frame.type === 'done') {
    // Chat Completions's terminal signal IS the `[DONE]` sentinel; Messages
    // and Responses have explicit terminal events (message_stop /
    // response.completed family) and never use `[DONE]` for health
    // classification.
    return targetApi === 'chat-completions' ? 'success' : null;
  }
  const event = frame.event as { type?: unknown; status?: unknown };
  const eventType = typeof event.type === 'string' ? event.type : undefined;

  if (targetApi === 'messages') {
    if (eventType === 'message_stop') return 'success';
    if (eventType === 'error') return 'failure';
    return null;
  }
  if (targetApi === 'responses') {
    if (eventType === 'response.completed' || eventType === 'response.incomplete') return 'success';
    if (eventType === 'response.failed') return 'failure';
    if (event.status === 'failed') return 'failure';
    return null;
  }
  // chat-completions's mid-stream `{error: {...}}` envelope is thrown by
  // parseChatCompletionsStream before any frame reaches downstream, so the
  // upstream-thrown path in withUpstreamTelemetry handles it. Nothing else
  // marks chat-completions as a failure terminal until [DONE] arrives.
  return null;
}

export function targetPerformanceContext(invocation: Invocation<unknown>, request: RequestContext, targetApi: PerformanceApiName, modelIdentity: TelemetryModelIdentity): PerformanceTelemetryContext {
  return {
    keyId: request.apiKeyId ?? 'unknown',
    model: modelIdentity.model,
    upstream: modelIdentity.upstream,
    modelKey: modelIdentity.modelKey,
    sourceApi: invocation.sourceApi,
    targetApi,
    stream: request.clientStream,
    runtimeLocation: request.runtimeLocation,
  };
}
