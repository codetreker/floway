import type { Context } from 'hono';

import { getCatalogModels } from '../providers/registry.ts';
import type { CatalogModel } from '../providers/types.ts';
import { ModelsFetchError, ModelsRequestError } from '../providers/upstream-model-cache.ts';

type GeminiGenerationMethod = 'generateContent' | 'streamGenerateContent' | 'countTokens';

interface GeminiModel {
  name: string;
  baseModelId?: string;
  version?: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: GeminiGenerationMethod[];
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  temperature?: number;
  maxTemperature?: number;
  topP?: number;
  topK?: number;
}

const toGeminiModel = (model: CatalogModel): GeminiModel => {
  const methods: GeminiGenerationMethod[] = ['generateContent', 'streamGenerateContent'];
  if (model.supportedEndpoints.includes('messages_count_tokens')) {
    methods.push('countTokens');
  }
  const limits = model.capabilities.limits;
  const inputTokenLimit = limits.max_prompt_tokens ?? limits.max_context_window_tokens;
  const outputTokenLimit = limits.max_output_tokens ?? limits.max_non_streaming_output_tokens;

  return {
    name: `models/${model.id}`,
    baseModelId: model.id,
    displayName: model.display_name ?? model.name,
    supportedGenerationMethods: methods,
    ...(inputTokenLimit !== undefined ? { inputTokenLimit } : {}),
    ...(outputTokenLimit !== undefined ? { outputTokenLimit } : {}),
    temperature: 1,
    topP: 0.95,
    topK: 40,
  };
};

const geminiStatusForHttpStatus = (status: number): string => {
  switch (status) {
  case 401:
    return 'UNAUTHENTICATED';
  case 403:
    return 'PERMISSION_DENIED';
  case 404:
    return 'NOT_FOUND';
  case 429:
    return 'RESOURCE_EXHAUSTED';
  case 502:
  case 503:
    return 'UNAVAILABLE';
  default:
    return status >= 500 ? 'INTERNAL' : 'INVALID_ARGUMENT';
  }
};

const geminiError = (status: number, message: string): Response => {
  const code = status >= 400 && status <= 599 ? status : 500;
  return Response.json(
    {
      error: { code, message, status: geminiStatusForHttpStatus(code) },
    },
    { status: code },
  );
};

const modelListingFailureMessage = 'Upstream model listing failed';

const geminiModelLoadError = (error: unknown): Response => {
  if (error instanceof ModelsFetchError) {
    return geminiError(error.status, modelListingFailureMessage);
  }
  if (error instanceof ModelsRequestError) {
    return geminiError(502, modelListingFailureMessage);
  }

  return geminiError(502, error instanceof Error ? error.message : String(error));
};

const loadGeminiModels = async (): Promise<GeminiModel[]> => {
  const models = await getCatalogModels();
  return models.filter(model => model.supports_generation).map(toGeminiModel);
};

export const serveGeminiModels = async (_c: Context): Promise<Response> => {
  try {
    return Response.json({ models: await loadGeminiModels() });
  } catch (error) {
    return geminiModelLoadError(error);
  }
};

export const serveGeminiModelInfo = async (c: Context): Promise<Response> => {
  const rawModelId = c.req.param('modelId');
  if (!rawModelId) return geminiError(404, 'Model not found: ');

  const modelId = rawModelId.replace(/^models\//, '');
  try {
    const model = (await loadGeminiModels()).find(candidate => candidate.baseModelId === modelId || candidate.name === `models/${modelId}`);
    if (!model) return geminiError(404, `Model not found: ${modelId}`);
    return Response.json(model);
  } catch (error) {
    return geminiModelLoadError(error);
  }
};
