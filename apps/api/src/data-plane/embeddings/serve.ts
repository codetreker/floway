// POST /v1/embeddings — route embedding requests to the provider that
// declares the requested model and embeddings capability.

import type { Context } from 'hono';

import type { BackgroundScheduler } from '../../runtime/background.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { toInternalDebugError } from '../llm/shared/errors/internal-debug-error.ts';
import { httpResponseToResponse, ProviderModelsUnavailableError } from '../providers/models-store.ts';
import { resolveModelForRequest } from '../providers/registry.ts';
import type { ProviderModelRecord } from '../providers/types.ts';
import type { PerformanceTelemetryContext } from '../shared/telemetry/performance.ts';
import { recordPerformanceError, recordPerformanceLatency, recordRequestPerformanceForApiKey, runtimeLocationFromRequest } from '../shared/telemetry/performance.ts';
import { recordTokenUsageForApiKey, tokenUsageFromPromptTokenResponse } from '../shared/telemetry/usage.ts';

interface EmbeddingsRequestBody {
  model?: unknown;
  input?: unknown;
  [key: string]: unknown;
}

const prepareEmbeddingsRequest = (body: string): { type: 'ok'; body: Record<string, unknown>; model: string } | { type: 'invalid'; message: string } => {
  let request: EmbeddingsRequestBody;

  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        type: 'invalid',
        message: 'Embeddings request body must be an object.',
      };
    }
    request = parsed as EmbeddingsRequestBody;
  } catch {
    return {
      type: 'invalid',
      message: 'Embeddings request body must be valid JSON.',
    };
  }

  if (typeof request.model !== 'string' || request.model.length === 0) {
    return {
      type: 'invalid',
      message: 'Embeddings request body must include a model string.',
    };
  }

  return { type: 'ok', body: request, model: request.model };
};

const modelsLoadErrorResponse = (error: unknown): Response | null =>
  error instanceof ProviderModelsUnavailableError ? httpResponseToResponse(error.httpResponse) : null;

const apiErrorResponse = (c: Context, message: string, status: 400 | 404): Response => c.json({ error: { message, type: 'api_error' } }, status);

const internalDebugErrorResponse = (c: Context, error: unknown): Response =>
  c.json({ error: toInternalDebugError(error, 'embeddings') }, 502);

const proxyJsonResponse = (resp: Response): Response =>
  new Response(resp.body, {
    status: resp.status,
    headers: {
      'content-type': resp.headers.get('content-type') ?? 'application/json',
    },
  });

const embeddingsPerformanceContext = (keyId: string | undefined, model: string, binding: ProviderModelRecord, modelKey: string, runtimeLocation: string): PerformanceTelemetryContext | undefined =>
  keyId
    ? {
        keyId,
        model,
        upstream: binding.upstream,
        modelKey,
        sourceApi: 'embeddings',
        targetApi: 'embeddings',
        stream: false,
        runtimeLocation,
      }
    : undefined;

const recordUpstreamPerformance = (scheduler: BackgroundScheduler | undefined, context: PerformanceTelemetryContext | undefined, failed: boolean, durationMs: number): void => {
  if (!context) return;
  const promise = failed ? recordPerformanceError(context, 'upstream_success') : recordPerformanceLatency(context, 'upstream_success', durationMs);
  scheduler ? scheduler(promise) : void promise;
};

export const embeddings = async (c: Context): Promise<Response> => {
  const requestStartedAt = performance.now();
  const apiKeyId = c.get('apiKeyId') as string | undefined;
  const runtimeLocation = runtimeLocationFromRequest(c.req.raw);
  const scheduleBackground = backgroundSchedulerFromContext(c);
  let lastPerformance: PerformanceTelemetryContext | undefined;

  try {
    const request = prepareEmbeddingsRequest(await c.req.text());
    if (request.type === 'invalid') {
      return apiErrorResponse(c, request.message, 400);
    }

    const { id: modelId, model } = await resolveModelForRequest(request.model);
    if (!model) {
      return apiErrorResponse(c, `No upstream provides model ${modelId}. Configure an upstream that exposes this model in the dashboard.`, 404);
    }

    for (const binding of model.providers) {
      if (!binding.upstreamModel.upstreamEndpoints.includes('embeddings')) {
        continue;
      }

      const { model: _model, ...body } = request.body;
      const upstreamStartedAt = performance.now();
      const { response, modelKey } = await binding.provider.callEmbeddings(binding.upstreamModel, body);
      const performanceContext = embeddingsPerformanceContext(apiKeyId, modelId, binding, modelKey, runtimeLocation);
      if (performanceContext) lastPerformance = performanceContext;

      if (!response.ok) {
        recordUpstreamPerformance(scheduleBackground, performanceContext, true, performance.now() - upstreamStartedAt);
        recordRequestPerformanceForApiKey(apiKeyId, scheduleBackground, performanceContext, true, performance.now() - requestStartedAt);
        return proxyJsonResponse(response);
      }

      try {
        const parsed = (await response.clone().json()) as unknown;
        const usage = tokenUsageFromPromptTokenResponse(parsed);
        recordUpstreamPerformance(scheduleBackground, performanceContext, false, performance.now() - upstreamStartedAt);
        if (usage) {
          await recordTokenUsageForApiKey(
            apiKeyId,
            {
              model: modelId,
              upstream: binding.upstream,
              modelKey,
              cost: binding.provider.getPricingForModelKey(modelKey),
            },
            usage,
          );
        }
      } catch (error) {
        recordUpstreamPerformance(scheduleBackground, performanceContext, true, performance.now() - upstreamStartedAt);
        throw error;
      }
      recordRequestPerformanceForApiKey(apiKeyId, scheduleBackground, performanceContext, false, performance.now() - requestStartedAt);
      return proxyJsonResponse(response);
    }

    return apiErrorResponse(c, `Model ${modelId} does not support the /embeddings endpoint.`, 400);
  } catch (e) {
    const response = modelsLoadErrorResponse(e);
    if (response) return response;

    recordRequestPerformanceForApiKey(apiKeyId, scheduleBackground, lastPerformance, true, performance.now() - requestStartedAt);
    return internalDebugErrorResponse(c, e);
  }
};
