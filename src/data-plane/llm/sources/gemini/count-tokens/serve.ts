import type { Context } from 'hono';

import { getModelCapabilities } from '../../../../providers/capabilities.ts';
import { resolveModelForRequest } from '../../../../providers/registry.ts';
import { ModelsFetchError } from '../../../../providers/upstream-model-cache.ts';
import type { GeminiContent, GeminiGenerateContentRequest } from '../../../../shared/protocol/gemini.ts';
import { buildTargetRequest as buildMessagesTargetRequest } from '../../../translate/gemini-via-messages/request.ts';
import { stripUnsupportedPartFieldsFromPayload } from '../interceptors/strip-unsupported-part-fields.ts';
import { stripUnsupportedToolsFromPayload } from '../interceptors/strip-unsupported-tools.ts';
import { geminiInternalRpcErrorResponse, geminiRpcErrorResponse } from '../respond.ts';

interface GeminiCountTokensRequest {
  contents?: GeminiContent[];
  generateContentRequest?: GeminiGenerateContentRequest;
}

const countTokensRequestToGenerateContentRequest = (request: GeminiCountTokensRequest): GeminiGenerateContentRequest => request.generateContentRequest ?? { contents: request.contents };

// count_tokens reuses Gemini source request normalization, but cannot run the
// full streaming source-interceptor pipeline. Apply the same payload mutations
// directly so its translated request shape matches `generateContent`.
const normalizeCountTokensRequest = (payload: GeminiGenerateContentRequest): void => {
  stripUnsupportedPartFieldsFromPayload(payload);
  stripUnsupportedToolsFromPayload(payload);
  delete payload.safetySettings;
};

const totalTokensFromUpstream = (value: unknown): number | null => {
  if (!value || typeof value !== 'object') return null;
  const payload = value as { input_tokens?: unknown; total_tokens?: unknown };
  if (typeof payload.input_tokens === 'number') return payload.input_tokens;
  if (typeof payload.total_tokens === 'number') return payload.total_tokens;
  return null;
};

export const countGeminiTokens = async (c: Context, model: string): Promise<Response> => {
  try {
    const request = await c.req.json<GeminiCountTokensRequest>();
    const generateContentRequest = countTokensRequestToGenerateContentRequest(request);
    normalizeCountTokensRequest(generateContentRequest);

    const { id: modelId, model: resolvedModel } = await resolveModelForRequest(model);

    if (!resolvedModel) {
      return geminiRpcErrorResponse(404, `Model ${modelId} is not available on any configured upstream.`);
    }

    let response: Response | undefined;
    for (const binding of resolvedModel.providers) {
      const capabilities = getModelCapabilities(binding.upstreamModel);
      if (!capabilities.supportsMessagesCountTokens) continue;

      const messagesPayload = buildMessagesTargetRequest(generateContentRequest, modelId, false, capabilities);
      const { model: _model, ...body } = messagesPayload;
      const result = await binding.provider.callMessagesCountTokens(binding.upstreamModel, body);
      response = result.response;
      break;
    }

    if (!response) {
      return geminiRpcErrorResponse(400, `Model ${modelId} does not support countTokens.`);
    }

    if (!response.ok) {
      const body = await response.text();
      return geminiRpcErrorResponse(response.status, body || 'Upstream token counting request failed.');
    }

    const parsed = (await response.json()) as unknown;
    const totalTokens = totalTokensFromUpstream(parsed);
    if (totalTokens === null) {
      return geminiInternalRpcErrorResponse(502, new Error('Invalid upstream token counting response.'));
    }

    return Response.json({ totalTokens });
  } catch (error) {
    if (error instanceof ModelsFetchError) {
      return geminiRpcErrorResponse(error.status, error.body);
    }

    return geminiInternalRpcErrorResponse(500, error);
  }
};
