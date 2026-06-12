import type { ProviderCandidate } from './candidates.ts';
import type { GatewayCtx } from './gateway-ctx.ts';
import { recordUpstreamHttpFailure, upstreamPerformanceContext, withUpstreamTelemetry } from './upstream-telemetry.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { eventResult, readUpstreamError, type ExecuteResult, type ProviderStreamResult, type TelemetryModelIdentity } from '@floway-dev/provider';

// Telemetry identity for the chosen candidate plus the upstream-reported
// model key. Pricing reads off the provider so the cost lookup respects any
// provider-specific override.
export const telemetryModelIdentity = (candidate: ProviderCandidate, modelKey: string): TelemetryModelIdentity => ({
  model: candidate.binding.upstreamModel.id,
  upstream: candidate.binding.upstream,
  modelKey,
  cost: candidate.binding.provider.getPricingForModelKey(modelKey),
});

// Lifts a provider's streaming-call result into the attempt's ExecuteResult
// shape, attaching the performance telemetry context every layer above reads:
// a non-ok provider response is read into an `upstream-error` carrying the
// context (and records its `upstream_success` failure), otherwise the events
// stream is wrapped with upstream telemetry and flows on with both the
// telemetry identity and the context. `durationMs` is the precise round-trip
// the provider measured by wrapping its fetch with `opts.recordUpstreamLatency`.
export const providerStreamResultToExecuteResult = async <TEvent>(
  providerResult: ProviderStreamResult<TEvent>,
  candidate: ProviderCandidate,
  ctx: GatewayCtx,
  durationMs: number,
): Promise<ExecuteResult<ProtocolFrame<TEvent>>> => {
  const context = upstreamPerformanceContext(ctx, candidate, providerResult.modelKey);
  if (!providerResult.ok) {
    recordUpstreamHttpFailure(ctx, context);
    return { ...(await readUpstreamError(providerResult.response)), performance: context };
  }
  return eventResult(
    withUpstreamTelemetry(providerResult.events as AsyncIterable<ProtocolFrame<TEvent>>, ctx, context, candidate.targetApi, durationMs),
    telemetryModelIdentity(candidate, providerResult.modelKey),
    context,
  );
};
