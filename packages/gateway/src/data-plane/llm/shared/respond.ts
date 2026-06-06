import type { StreamCompletion } from './stream/sse.ts';
import type { TokenUsage } from '../../../repo/types.ts';
import { recordRequestPerformanceForApiKey } from '../../shared/telemetry/performance.ts';
import { hasTokenUsage, recordTokenUsageForApiKey } from '../../shared/telemetry/usage.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { plainResult } from '@floway-dev/provider';
import type { EventResultMetadata, ExecuteResult, PlainResult, TelemetryModelIdentity } from '@floway-dev/provider';

// Emits a measurement endpoint's already-shaped body verbatim. The endpoint's
// `attempt` owns all shaping — the success body and any source-specific error
// envelope — so every source's `respond` renders a plain result identically.
export const plainResultToResponse = (result: PlainResult): Response =>
  new Response(result.body.slice().buffer, { status: result.status, headers: result.headers });

// Captures an upstream HTTP response as a plain result, keeping its status and
// content type. Used by count_tokens endpoints that either pass through the
// upstream body or wrap an already-built error/success Response.
export const plainResultFromResponse = async (response: Response): Promise<PlainResult> =>
  plainResult(
    response.status,
    new Headers({ 'content-type': response.headers.get('content-type') ?? 'application/json' }),
    new Uint8Array(await response.arrayBuffer()),
  );

// Per-stream observation accumulated by each source's frame observer and read
// back when the response settles: did the stream fail, did it reach its
// terminal frame, and the last frame-level usage worth billing.
export class SourceStreamState {
  failed = false;
  completed = false;
  usage: TokenUsage | null = null;

  // Only a frame carrying real (non-zero) usage overwrites the running figure,
  // so an empty trailing frame can't wipe a good count.
  rememberUsage(usage: TokenUsage | null): void {
    if (usage && hasTokenUsage(usage)) this.usage = usage;
  }

  // Whether the streamed response should be recorded as failed: an upstream or
  // internal error frame set `failed`, the writer reported an error completion,
  // or the client cancelled before the terminal frame arrived.
  failedAfter(completion: StreamCompletion): boolean {
    return completion === 'error' || this.failed || (completion === 'cancel' && !this.completed);
  }
}

// The events result's metadata, resolved once: prefer the upstream's finalized
// metadata, else fall back to the identity/performance carried on the result.
export const eventResultMetadata = async <TEvent>(result: Extract<ExecuteResult<ProtocolFrame<TEvent>>, { type: 'events' }>): Promise<EventResultMetadata> =>
  await (result.finalMetadata ?? {
    modelIdentity: result.modelIdentity,
    ...(result.performance ? { performance: result.performance } : {}),
  });

// `GatewayCtx.apiKeyId` is `string | null`; the telemetry helpers accept
// `string | undefined` and skip on falsy. Coerce here to satisfy the signature
// without losing the no-op-on-missing-key behavior.
export const recordUsage = async (ctx: GatewayCtx, modelIdentity: TelemetryModelIdentity, usage: TokenUsage | null): Promise<void> => {
  if (usage && hasTokenUsage(usage)) await recordTokenUsageForApiKey(ctx.apiKeyId ?? undefined, modelIdentity, usage);
};

// `GatewayCtx.scheduleBackground` takes a thunk returning Promise<void> | void;
// the telemetry helper hands us a promise — adapt by returning it from the
// thunk (the `Promise<unknown>` cast keeps TypeScript happy without inserting
// an await).
export const recordPerformance = (ctx: GatewayCtx, context: EventResultMetadata['performance'], failed: boolean): void => {
  const scheduler = (promise: Promise<unknown>) => ctx.scheduleBackground(() => promise as Promise<void>);
  recordRequestPerformanceForApiKey(ctx.apiKeyId ?? undefined, scheduler, context, failed, performance.now() - ctx.requestStartedAt);
};
