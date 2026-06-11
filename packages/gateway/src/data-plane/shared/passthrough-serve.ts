// Shared serve scaffold for non-LLM passthrough data-plane endpoints. These
// bypass the LLM source/target executor because they have no protocol
// translation — the request body is forwarded to the chosen provider's
// matching endpoint and the JSON response is passed through back to the
// client. The shape is:
//
//   resolve model -> iterate provider bindings -> first matching binding
//     -> provider call -> passthrough response -> fire-and-forget usage + perf
//
// Usage extraction is provided by the caller because each endpoint family
// reports usage differently. Usage and request-performance writes are
// scheduled through the runtime's background scheduler so transient repo
// failures cannot turn a successful 200 from upstream into a 502.

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { NonLlmServeApiName } from './api-names.ts';
import type { PerformanceTelemetryContext } from './telemetry/performance.ts';
import { createUpstreamLatencyRecorder, recordPerformanceError, recordPerformanceLatency, recordRequestPerformance, runtimeLocationFromRequest } from './telemetry/performance.ts';
import { recordTokenUsage } from './telemetry/usage.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { effectiveUpstreamIdsFromContext } from '../../middleware/auth.ts';
import type { TokenUsage } from '../../repo/types.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { resolveModelForRequest } from '../providers/registry.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { httpResponseToResponse, ProviderModelsUnavailableError, toInternalDebugError } from '@floway-dev/provider';
import type { ProviderCallResult, ProviderModelRecord, UpstreamCallOptions } from '@floway-dev/provider';

// Headers we forward verbatim from a successful upstream JSON response, plus
// content-type with an application/json fallback when the upstream omitted
// it. The set is intentionally narrow and matches the passthrough contract
// OpenAI clients (and the OpenAI Node SDK retry policy) expect to see —
// correlation, organisation/model metadata, quota signals, retry-after.
const FORWARDED_RESPONSE_HEADER_PREFIXES = ['openai-', 'x-ratelimit-'] as const;
const FORWARDED_RESPONSE_HEADERS = new Set(['x-request-id', 'retry-after', 'cf-ray']);

const forwardedResponseHeaders = (resp: Response): Headers => {
  const headers = new Headers({ 'content-type': resp.headers.get('content-type') ?? 'application/json' });
  for (const [name, value] of resp.headers.entries()) {
    const lower = name.toLowerCase();
    if (lower === 'content-type') continue;
    if (FORWARDED_RESPONSE_HEADERS.has(lower) || FORWARDED_RESPONSE_HEADER_PREFIXES.some(prefix => lower.startsWith(prefix))) {
      headers.set(name, value);
    }
  }
  return headers;
};

const forwardUpstreamResponse = (resp: Response): Response =>
  new Response(resp.body, {
    status: resp.status,
    headers: forwardedResponseHeaders(resp),
  });

const recordUpstreamPerformance = (
  scheduler: BackgroundScheduler,
  context: PerformanceTelemetryContext,
  failed: boolean,
  durationMs: number,
): void => {
  scheduler(failed ? recordPerformanceError(context, 'upstream_success') : recordPerformanceLatency(context, 'upstream_success', durationMs));
};

// Fire-and-forget the usage record. A transient D1/KV failure here must not
// surface as a 502 to a client whose upstream call already succeeded with a
// 200 response body in hand. We log so the failure is still observable.
const scheduleUsageRecord = (scheduler: BackgroundScheduler, promise: Promise<void>): void => {
  scheduler(promise.catch(error => {
    console.error('Failed to record token usage:', error);
  }));
};

// Defensive JSON parse: a successful 200 with a non-JSON or unexpected body
// (rare for these endpoints, but possible if an upstream-side proxy starts
// returning binary or a wrapped envelope) must not 502 the client; we
// simply skip usage extraction in that case, but log the parse failure so
// operators can correlate when usage rows go missing.
const safeJsonClone = async (resp: Response, sourceApi: NonLlmServeApiName): Promise<unknown> => {
  try {
    return await resp.clone().json();
  } catch (e) {
    console.warn(`passthrough-serve: failed to parse 2xx upstream body for ${sourceApi}; usage row will be skipped`, e instanceof Error ? e.message : String(e));
    return undefined;
  }
};

export interface PassthroughServeContext {
  readonly c: Context;
  readonly sourceApi: NonLlmServeApiName;
  // Already-validated public model id the client requested. The helper
  // resolves it against the provider registry; if no upstream serves the
  // id, the client sees a 404 with the standard wording.
  readonly model: string;
  readonly bindingServesEndpoint: (binding: ProviderModelRecord) => boolean;
  // Performs the upstream HTTP call for the chosen binding. Any throw here
  // is preserved and becomes a 502 with the internal-debug envelope —
  // exceptions thrown from the actual fetch must not be silently swallowed.
  // `opts` carries the per-call hooks the gateway threads in (the
  // recordUpstreamLatency wrapper for the upstream_success metric); the
  // callback forwards it verbatim to the chosen provider call method.
  readonly call: (binding: ProviderModelRecord, opts: UpstreamCallOptions) => Promise<ProviderCallResult>;
  // Extracts a usage row from the `usage` block of a parsed 2xx upstream
  // body. The helper does the shallow `parsed.usage` lookup so each
  // extractor only has to validate the usage shape. Return null when the
  // usage block is missing or malformed.
  readonly extractUsage: (usage: unknown) => TokenUsage | null;
  // Returned as the 400 body when no provider binding matched. Phrased
  // per-endpoint so the error tells the client which capability is missing.
  readonly noBindingMessage: (modelId: string) => string;
}

export const passthroughServe = async (ctx: PassthroughServeContext): Promise<Response> => {
  const { c, sourceApi, model, bindingServesEndpoint, call, extractUsage, noBindingMessage } = ctx;
  const requestStartedAt = performance.now();
  const apiKeyId = c.get('apiKeyId') as string;
  const runtimeLocation = runtimeLocationFromRequest(c.req.raw);
  const scheduleBackground = backgroundSchedulerFromContext(c);
  let lastPerformance: PerformanceTelemetryContext | undefined;

  try {
    const fetcherForUpstream = await createPerRequestFetcher();
    const { id: modelId, model: resolved } = await resolveModelForRequest(model, effectiveUpstreamIdsFromContext(c), fetcherForUpstream);
    if (!resolved) {
      return passthroughApiError(c, `Model ${modelId} is not available on any configured upstream.`, 404);
    }

    for (const binding of resolved.providers) {
      if (!bindingServesEndpoint(binding)) continue;

      const recorder = createUpstreamLatencyRecorder();
      const { response, modelKey } = await call(binding, { fetcher: fetcherForUpstream(binding.upstream), recordUpstreamLatency: recorder.record });
      const upstreamDurationMs = recorder.durationMs();
      const performanceContext: PerformanceTelemetryContext = {
        keyId: apiKeyId,
        model: modelId,
        upstream: binding.upstream,
        modelKey,
        stream: false,
        runtimeLocation,
      };
      lastPerformance = performanceContext;

      if (!response.ok) {
        recordUpstreamPerformance(scheduleBackground, performanceContext, true, upstreamDurationMs);
        recordRequestPerformance(scheduleBackground, performanceContext, true, performance.now() - requestStartedAt);
        return forwardUpstreamResponse(response);
      }

      recordUpstreamPerformance(scheduleBackground, performanceContext, false, upstreamDurationMs);
      const parsed = await safeJsonClone(response, sourceApi);
      const usageBlock = parsed && typeof parsed === 'object' ? (parsed as { usage?: unknown }).usage : undefined;
      const usage = usageBlock !== undefined ? extractUsage(usageBlock) : null;
      if (usage) {
        scheduleUsageRecord(
          scheduleBackground,
          recordTokenUsage(
            apiKeyId,
            {
              model: modelId,
              upstream: binding.upstream,
              modelKey,
              cost: binding.provider.getPricingForModelKey(modelKey),
            },
            usage,
          ),
        );
      }
      recordRequestPerformance(scheduleBackground, performanceContext, false, performance.now() - requestStartedAt);
      return forwardUpstreamResponse(response);
    }

    return passthroughApiError(c, noBindingMessage(modelId), 400);
  } catch (e) {
    if (e instanceof ProviderModelsUnavailableError) {
      const forwarded = httpResponseToResponse(e.httpResponse);
      if (forwarded) return forwarded;
    }
    recordRequestPerformance(scheduleBackground, lastPerformance, true, performance.now() - requestStartedAt);
    return c.json({ error: toInternalDebugError(e, sourceApi) }, 502);
  }
};

// Uniform error envelope for this endpoint family.
export const passthroughApiError = (c: Context, message: string, status: ContentfulStatusCode): Response =>
  c.json({ error: { message, type: 'api_error' } }, status);
