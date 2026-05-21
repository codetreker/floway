import type { Context } from 'hono';

import type { ModelInfo, ModelsResponse } from '../../data-plane/models/types.ts';
import { modelEndpointsToPublicPaths } from '../../data-plane/providers/endpoints.ts';
import { getModels } from '../../data-plane/providers/registry.ts';
import type { ModelMetadata, ResolvedModel } from '../../data-plane/providers/types.ts';
import { ModelsFetchError, ModelsRequestError } from '../../data-plane/providers/upstream-model-cache.ts';

interface ControlPlaneModelInfo extends ModelInfo {
  // Compatibility hint for the existing dashboard picker grouping. Public
  // data-plane model APIs deliberately do not emit provider identity.
  name: string;
  version: string;
  display_name: string;
  created_at?: string;
  description?: string;
  capabilities: ModelMetadata['capabilities'];
  supported_endpoints: string[];
  supports_generation: boolean;
  upstream_kind: 'copilot' | 'openai';
  billing?: ResolvedModel['billing'];
  policy?: ResolvedModel['policy'];
  model_picker_enabled?: boolean;
}

interface ControlPlaneModelsResponse extends Omit<ModelsResponse, 'data'> {
  data: ControlPlaneModelInfo[];
}

const modelUpstreamKind = (model: ResolvedModel): ControlPlaneModelInfo['upstream_kind'] => (model.providers.some(binding => binding.upstream.startsWith('copilot:')) ? 'copilot' : 'openai');

const toControlPlaneModelInfo = (model: ResolvedModel): ControlPlaneModelInfo => {
  const displayName = model.display_name ?? model.name ?? model.id;
  const info: ControlPlaneModelInfo = {
    id: model.id,
    object: model.object,
    name: displayName,
    version: model.version,
    display_name: displayName,
    ...(model.owned_by !== undefined ? { owned_by: model.owned_by } : {}),
    ...(model.created !== undefined ? { created: model.created } : {}),
    ...(model.created_at !== undefined ? { created_at: model.created_at } : {}),
    ...(model.description !== undefined ? { description: model.description } : {}),
    capabilities: model.capabilities,
    supported_endpoints: modelEndpointsToPublicPaths(model.supportedEndpoints),
    supports_generation: model.supports_generation,
    upstream_kind: modelUpstreamKind(model),
  };
  if (model.billing) info.billing = model.billing;
  if (model.policy) info.policy = model.policy;
  if (model.model_picker_enabled !== undefined) {
    info.model_picker_enabled = model.model_picker_enabled;
  }
  return info;
};

const modelListingFailureMessage = 'Upstream model listing failed';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const controlPlaneModels = async (c: Context): Promise<Response> => {
  try {
    const models = await getModels();
    const response: ControlPlaneModelsResponse = {
      object: 'list',
      data: models.map(toControlPlaneModelInfo),
    };
    return Response.json(response);
  } catch (e: unknown) {
    if (e instanceof ModelsFetchError) {
      return Response.json({ error: { message: modelListingFailureMessage, type: 'api_error' } }, { status: e.status });
    }
    if (e instanceof ModelsRequestError) {
      return Response.json({ error: { message: modelListingFailureMessage, type: 'api_error' } }, { status: 502 });
    }
    return c.json({ error: { message: errorMessage(e), type: 'api_error' } }, 502);
  }
};
