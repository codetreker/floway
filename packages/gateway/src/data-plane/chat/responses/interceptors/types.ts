import type { TokenUsage } from '../../../../repo/types.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import type { StatefulResponsesStore } from '../items/store.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult, ResponsesInvocation as ProviderResponsesInvocation, TelemetryModelIdentity } from '@floway-dev/provider';

// App-side ResponsesInvocation extends the provider-package slim shape with
// the per-request stateful store. Provider interceptors only see the slim
// fields (parameter contravariance lets app-side richer instances flow in),
// while api-internal interceptors that need stored-item lookups read `store`.
// The `action` field on the provider shape is mutable through the chain;
// mutations are one-way per the project's interceptor convention (no
// interceptor restores fields it wrote). Whatever consumes the chain's
// outputs post-run keeps its own captured copy of the caller's intent.
export interface ResponsesInvocation extends ProviderResponsesInvocation {
  readonly store: StatefulResponsesStore;
}

// The chain runner produces an event stream for both actions — the attempt
// post-processes it into a single `response.compaction` envelope when the
// caller's intent action was 'compact'. `modelIdentity` and `usage` carry
// the per-turn attribution forward so the http layer's `ctx.dump` records
// the success path identically to streaming generate.
export type ResponsesAttemptResult =
  | ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
  | {
    readonly type: 'result';
    readonly result: ResponsesResult;
    readonly modelIdentity: TelemetryModelIdentity;
    readonly usage: TokenUsage | null;
  };

export type ResponsesInterceptor = Interceptor<
  ResponsesInvocation,
  GatewayCtx,
  ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
>;
