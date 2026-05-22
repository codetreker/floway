// GET /v1/models and /models — expose provider registry models in the public
// protocol shape without leaking provider bindings or raw upstream variants.

import type { Context } from 'hono';

import { loadAnthropicModels, loadMergedModels } from './load.ts';
import { ProviderModelsUnavailableError } from '../providers/models-store.ts';

const modelListingFailureMessage = 'Upstream model listing failed';

const apiErrorResponse = (message: string, status: number): Response => Response.json({ error: { message, type: 'api_error' } }, { status });

// Upstream HTTP/parse failures are squashed to a generic 502 to avoid leaking
// upstream identity. Other errors (e.g. the registry's "no upstream configured"
// hint) carry actionable operator guidance and should surface verbatim.
const modelLoadErrorResponse = (error: unknown): Response => {
  if (error instanceof ProviderModelsUnavailableError) {
    return apiErrorResponse(modelListingFailureMessage, 502);
  }
  return apiErrorResponse(error instanceof Error ? error.message : String(error), 502);
};

export const models = async (_c: Context) => {
  try {
    return Response.json(await loadMergedModels());
  } catch (e) {
    return modelLoadErrorResponse(e);
  }
};

export const anthropicModels = async (_c: Context) => {
  try {
    return Response.json(await loadAnthropicModels());
  } catch (e) {
    return modelLoadErrorResponse(e);
  }
};
