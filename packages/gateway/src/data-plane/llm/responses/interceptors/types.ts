import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import type { StatefulResponsesStore } from '../items/store.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult, ResponsesInvocation as ProviderResponsesInvocation } from '@floway-dev/provider';

// App-side ResponsesInvocation extends the provider-package slim shape with
// the per-request stateful store. Provider interceptors only see the slim
// fields (parameter contravariance lets app-side richer instances flow in),
// while api-internal interceptors that need stored-item lookups read `store`.
export interface ResponsesInvocation extends ProviderResponsesInvocation {
  readonly store: StatefulResponsesStore;
}

// Compact post-processes the chain's event stream into a single
// `response.compaction` envelope and returns it as a value; generate keeps
// the events branch. The chain runner itself stays narrow over
// `ExecuteResult<…ResponsesStreamEvent>` so existing interceptors retain
// their event-stream contract — the result branch is observable only on
// `responsesAttempt.compact`'s outer return.
export type ResponsesAttemptResult =
  | ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
  | { readonly type: 'result'; readonly result: ResponsesResult };

export type ResponsesInterceptor = Interceptor<
  ResponsesInvocation,
  GatewayCtx,
  ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
>;
