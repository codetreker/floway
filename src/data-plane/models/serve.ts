// GET /v1/models and /models — expose provider registry models in the public
// protocol shape without leaking provider bindings or raw upstream variants.

import type { Context } from 'hono';

import { loadAnthropicModels, loadMergedModels } from './load.ts';
import { ModelsFetchError, ModelsRequestError } from '../providers/upstream-model-cache.ts';

const modelListingFailureMessage = 'Upstream model listing failed';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const apiErrorResponse = (message: string, status: number): Response => Response.json({ error: { message, type: 'api_error' } }, { status });

export const models = async (_c: Context) => {
  try {
    return Response.json(await loadMergedModels());
  } catch (e: unknown) {
    if (e instanceof ModelsFetchError) {
      return apiErrorResponse(modelListingFailureMessage, e.status);
    }
    if (e instanceof ModelsRequestError) {
      return apiErrorResponse(modelListingFailureMessage, 502);
    }
    return apiErrorResponse(errorMessage(e), 502);
  }
};

export const anthropicModels = async (_c: Context) => {
  try {
    return Response.json(await loadAnthropicModels());
  } catch (e: unknown) {
    if (e instanceof ModelsFetchError) {
      return apiErrorResponse(modelListingFailureMessage, e.status);
    }
    if (e instanceof ModelsRequestError) {
      return apiErrorResponse(modelListingFailureMessage, 502);
    }
    return apiErrorResponse(errorMessage(e), 502);
  }
};
