import type { CopilotUpstreamConfig } from './config.ts';
import { copilotFetchModels } from './fetch.ts';
import type { CopilotModelsResponse } from './types.ts';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';

const isCopilotModelsResponse = (value: unknown): value is CopilotModelsResponse => {
  const response = value as CopilotModelsResponse;
  return (
    typeof response?.object === 'string'
    && Array.isArray(response.data)
    && response.data.every(model => typeof model?.id === 'string')
  );
};

// VSCode Copilot Chat tags `/models` calls with the `model-access` intent
// instead of the generic `conversation-agent` one used for generation calls,
// and omits `Content-Type` since the request has no body. Probing both header
// sets returned byte-identical bodies and policy headers, so the only
// motivation is semantic alignment with VSCode's wire shape.
//
// Reference (caozhiyuan/copilot-api uses the same split):
// https://github.com/caozhiyuan/copilot-api/blob/main/src/lib/api-config.ts
const MODELS_HEADER_OVERRIDES: Record<string, string> = {
  'openai-intent': 'model-access',
  'x-interaction-type': 'model-access',
  'content-type': '',
};

export const fetchCopilotModels = async (config: Pick<CopilotUpstreamConfig, 'githubToken' | 'accountType'>): Promise<CopilotModelsResponse> => {
  let response: Response;
  try {
    response = await copilotFetchModels(config, { method: 'GET' }, { extraHeaders: MODELS_HEADER_OVERRIDES });
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
