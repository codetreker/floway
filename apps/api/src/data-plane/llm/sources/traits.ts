import type { Context } from 'hono';

import type { NonLlmServeApiName } from '../../shared/api-names.ts';
import type { LlmTargetApi, RequestContext } from '../interceptors.ts';
import type { ResponsesSnapshotMode } from './responses/stateful-store.ts';
import type { ModelEndpoints, ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
import { type PerformanceApiName, type ProviderModelRecord, type ExecuteResult, type PlainResult, type UpstreamErrorResult, internalErrorResult } from '@floway-dev/provider';
import { ProviderModelsUnavailableError, toInternalDebugError } from '@floway-dev/provider';
import type { Mutable, ResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

type Frame<TEvent> = ProtocolFrame<TEvent>;
export type Result<TEvent> = ExecuteResult<Frame<TEvent>> | PlainResult;

// Every way `serveLlm` can fail before producing a usable upstream result.
// These are protocol-agnostic: each source's `renderFailure` maps a failure to
// its own error envelope, so `LlmServeFailure` × source-protocol is a cartesian
// product. The failure carries only the minimum to render — never a pre-shaped
// body — because the body belongs to whichever protocol is answering.
//
// `item-not-found` re-creates a stored Responses item miss. Under the Responses
// protocol the gateway stands in for OpenAI's own item store, so the rendered
// body must byte-match OpenAI's native "not found" response (that exact shape
// lives in the Responses source); other protocols render the miss in their own
// envelope.
//
// `routing-unavailable` is gateway-invented — a stored item names an upstream
// that cannot serve the current model — so it has no external exact-body
// contract; its diagnosis text is built where the conflict is detected.
//
// `model-missing` / `model-unsupported` describe the provider walk finding no
// usable binding for the requested model. `internal` is an unexpected throw,
// surfaced as 5xx with a stack trace.
//
// Data corruption (a stored row whose item_type we no longer recognize) is NOT
// modeled here: it stays a plain Error and reaches the top-level catch as
// `internal`.
export type LlmServeFailure =
  | { kind: 'item-not-found'; itemId: string }
  | { kind: 'routing-unavailable'; message: string }
  | { kind: 'model-missing'; model: string }
  | { kind: 'model-unsupported'; model: string }
  | { kind: 'internal'; error: unknown };

// Carries a failure thrown from deep in request handling (e.g. a stored-item
// rewrite discovering an unsatisfiable reference) up to `serveLlm`, which maps
// it back into a `LlmServeFailure` for the source to render.
export class LlmServeFailureError extends Error {
  readonly failure: LlmServeFailure;

  constructor(failure: LlmServeFailure) {
    super(`LlmServeFailure: ${failure.kind}`);
    this.name = 'LlmServeFailureError';
    this.failure = failure;
  }
}

export const throwLlmServeFailure = (failure: LlmServeFailure): never => {
  throw new LlmServeFailureError(failure);
};

type PerformanceLlmSourceApi = Exclude<PerformanceApiName, NonLlmServeApiName>;

// The base every source's `renderFailure` wraps: a synthetic `upstream-error`
// result carrying a gateway-built JSON body, so the respond layer renders a
// gateway-invented failure through the same path as a real upstream error.
export const jsonUpstreamErrorResult = (status: number, body: unknown): UpstreamErrorResult => ({
  type: 'upstream-error',
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(JSON.stringify(body)),
});

// Renders the `internal` failure kind shared by every source: a thrown upstream
// error passes through verbatim, otherwise the caught value becomes an
// internal-error result with a stack trace tagged to the source API.
export const sourceErrorResult = <TEvent>(
  error: unknown,
  options: {
    sourceApi: PerformanceLlmSourceApi;
    internalStatus: number;
  },
): ExecuteResult<Frame<TEvent>> => {
  const upstreamError = providerModelsUnavailableUpstreamError(error);
  if (upstreamError) return upstreamError;

  return internalErrorResult(options.internalStatus, toInternalDebugError(error, options.sourceApi));
};

// Translate the live wrapper provider models-store throws when a provider's
// remote `/models` endpoint returned an HTTP error into the canonical
// upstream-error result, so the source layer surfaces upstream failures
// verbatim rather than collapsing them into a 500.
const providerModelsUnavailableUpstreamError = (error: unknown): UpstreamErrorResult | null => {
  if (!(error instanceof ProviderModelsUnavailableError) || !error.httpResponse) return null;
  const { status, headers, body } = error.httpResponse;
  return {
    type: 'upstream-error',
    status,
    headers: new Headers(headers),
    body: new TextEncoder().encode(body),
  };
};

export interface LlmSourceRuntime {
  readonly request: RequestContext;
  readonly wantsStream: boolean;
  readonly downstreamAbortController: AbortController | undefined;
}

export interface LlmEndpointPlan<TItems, TEvent> extends LlmSourceRuntime {
  readonly items: TItems;
  readonly responsesItemsView: ResponsesItemsView<TItems, Frame<TEvent>>;
  // Controls Responses output item persistence: `store: false` keeps routing
  // metadata with null payloads. Input staging and snapshot commits are gated
  // separately because only native Responses requests expose those concepts.
  readonly store: boolean | null | undefined;
  readonly statefulResponsesInputItems?: readonly ResponsesInputItem[];
  // How to compose this turn's snapshot (default 'none' — no snapshot
  // commit). `/responses` generate uses 'append' (previous + input + output);
  // `/responses/compact` uses 'replace' (output only — see ResponsesSnapshotMode).
  readonly responsesSnapshotMode?: ResponsesSnapshotMode;
  // The model id the planner resolves against. Most sources read it off the
  // parsed payload; Gemini carries it on the request path instead of the body.
  readonly model: string;
  pickTarget(endpoints: ModelEndpoints): LlmTargetApi | null;
  // Clones the captured payload once, rewrites that clone's items in place via
  // `rewriteItems`, builds the fully protocol-typed invocation / emit table /
  // interceptor chain, and runs. The single per-attempt clone is the sole
  // source of mutation isolation, so the rewrite runs on owned items — never on
  // the original parsed items the orchestrator still iterates read-only.
  attempt(input: {
    binding: ProviderModelRecord;
    target: LlmTargetApi;
    model: string;
    rewriteItems: (items: TItems) => Promise<Mutable<TItems>>;
  }): Promise<Result<TEvent>>;
}

// One client-facing operation of a source. Every endpoint shares the source's
// input (TItems) and `renderFailure`, and differs only in how it reaches the
// upstream and shapes the answer:
//   - generate produces LLM output — an `events` result whose output items the
//     orchestrator persists, then `respond` renders.
//   - count_tokens produces a measurement — a non-`events` result the
//     orchestrator passes straight to `respond`, never persisting.
//
// `pickTarget` and `attempt` are NOT here: they live on the plan `prepare`
// returns, because `attempt` closes over the parsed payload.
export interface LlmHttpEndpoint<TItems, TEvent> {
  // Parses the body, runs input-level pre-checks (returning an early
  // `Response`), and yields the plan the orchestrator drives.
  prepare(c: Context): Promise<LlmEndpointPlan<TItems, TEvent> | Response>;
  // Shapes the final Response from a result — both upstream results and the
  // `renderFailure` envelope pass through here. Reports only whether the
  // response was produced; the orchestrator owns commit timing for persisted
  // items.
  respond(input: {
    c: Context;
    result: Result<TEvent>;
    runtime: LlmSourceRuntime;
  }): Promise<{ success: boolean; response: Response }>;
}

export type LlmEndpointName = 'generate' | 'countTokens' | 'compact';

// A source exposes one or more endpoints that share its input and error
// envelope. `renderFailure` is source-wide — every endpoint answers a failure
// in the same protocol shape — while the per-endpoint pieces live on
// `LlmHttpEndpoint`.
export interface LlmSourceTraits<TItems, TEvent> {
  renderFailure(failure: LlmServeFailure, endpoint: LlmEndpointName): Result<TEvent>;
  endpoints: Partial<Record<LlmEndpointName, LlmHttpEndpoint<TItems, TEvent>>>;
}
