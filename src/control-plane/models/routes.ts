import type { Context } from 'hono';

import type { ModelInfo, ModelsResponse } from '../../data-plane/models/types.ts';
import { modelEndpointsToPublicPaths } from '../../data-plane/providers/endpoints.ts';
import { ProviderModelsUnavailableError } from '../../data-plane/providers/models-store.ts';
import { getModels } from '../../data-plane/providers/registry.ts';
import type { ModelMetadata, ResolvedModel } from '../../data-plane/providers/types.ts';
import type { UpstreamProviderKind } from '../../repo/types.ts';

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
  provider: UpstreamProviderKind;
  upstream_ids: string[];
  billing?: ResolvedModel['billing'];
  policy?: ResolvedModel['policy'];
  model_picker_enabled?: boolean;
}

interface ControlPlaneModelsResponse extends Omit<ModelsResponse, 'data'> {
  data: ControlPlaneModelInfo[];
}

const modelProvider = (model: ResolvedModel): UpstreamProviderKind => {
  const first = model.providers[0];
  if (!first) throw new Error(`Resolved model ${model.id} has no provider bindings`);
  return first.providerKind;
};

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
    provider: modelProvider(model),
    upstream_ids: [...new Set(model.providers.map(provider => provider.upstream))],
    ...(model.cost ? { cost: model.cost } : {}),
  };
  if (model.billing) info.billing = model.billing;
  if (model.policy) info.policy = model.policy;
  if (model.model_picker_enabled !== undefined) {
    info.model_picker_enabled = model.model_picker_enabled;
  }
  return info;
};

const modelListingFailureMessage = 'Upstream model listing failed';

export const controlPlaneModels = async (c: Context): Promise<Response> => {
  try {
    const models = await getModels();
    const response: ControlPlaneModelsResponse = {
      object: 'list',
      data: models.map(toControlPlaneModelInfo),
    };
    return Response.json(response);
  } catch (e: unknown) {
    // Genuine upstream HTTP/parse failures are squashed to a generic 502 so
    // the control plane does not leak provider identity. Other errors
    // (e.g. the registry's "no upstream configured" hint) carry actionable
    // operator guidance and surface verbatim.
    if (e instanceof ProviderModelsUnavailableError) {
      return c.json({ error: { message: modelListingFailureMessage, type: 'api_error' } }, 502);
    }
    return c.json({ error: { message: e instanceof Error ? e.message : String(e), type: 'api_error' } }, 502);
  }
};
