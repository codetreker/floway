import type { Upstream } from '../../../shared/upstream/types.ts';
import { ProviderModelsUnavailableError } from '../models-store.ts';

// OpenAI-shaped /models response from any bearer-token upstream the admin
// configures. The wire shape is OpenAI's own: id is required, name/owned_by/
// created are optional metadata. `supported_endpoints` is a custom-gateway
// convention some upstreams emit to declare per-model endpoint support.
export interface CustomRawModel {
  id: string;
  name?: string;
  owned_by?: string;
  created?: number;
  supported_endpoints?: string[];
}

export interface CustomModelsResponse {
  object: string;
  data: CustomRawModel[];
}

const isCustomModelsResponse = (value: unknown): value is CustomModelsResponse => {
  const response = value as CustomModelsResponse;
  return (
    typeof response?.object === 'string'
    && Array.isArray(response.data)
    && response.data.every(model => typeof model?.id === 'string')
  );
};

export const fetchCustomModels = async (upstream: Upstream): Promise<CustomModelsResponse> => {
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
  if (!isCustomModelsResponse(parsed)) {
    throw new ProviderModelsUnavailableError(null, new Error('Invalid /models response shape'));
  }
  return parsed;
};
