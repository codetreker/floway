import type { CopilotModelsResponse } from './types.ts';
import type { Upstream } from '../../../shared/upstream/types.ts';
import { ProviderModelsUnavailableError } from '../models-store.ts';

const isCopilotModelsResponse = (value: unknown): value is CopilotModelsResponse => {
  const response = value as CopilotModelsResponse;
  return (
    typeof response?.object === 'string'
    && Array.isArray(response.data)
    && response.data.every(model => typeof model?.id === 'string')
  );
};

export const fetchCopilotModels = async (upstream: Upstream): Promise<CopilotModelsResponse> => {
  let response: Response;
  try {
    response = await upstream.fetch('models', { method: 'GET' });
  } catch (cause) {
    throw new ProviderModelsUnavailableError(null, cause);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new ProviderModelsUnavailableError({
      status: response.status,
      headers: new Headers(response.headers),
      body,
    });
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (cause) {
    throw new ProviderModelsUnavailableError(null, cause);
  }
  if (!isCopilotModelsResponse(parsed)) {
    throw new ProviderModelsUnavailableError(null, new Error('Invalid /models response shape'));
  }
  return parsed;
};
