import { getInternalModels } from '../providers/registry.ts';
import type { InternalModel } from '../providers/types.ts';
import type { PublicModel, PublicModelsResponse } from '@copilot-gateway/protocols/common';

export const toPublicModel = (model: InternalModel): PublicModel => {
  const info: PublicModel = {
    id: model.id,
    object: 'model',
    type: 'model',
    display_name: model.display_name ?? model.id,
    limits: { ...model.limits },
    supports_generation: model.supports_generation,
  };
  if (model.owned_by !== undefined) info.owned_by = model.owned_by;
  if (model.created !== undefined) {
    info.created = model.created;
    info.created_at = new Date(model.created * 1000).toISOString();
  }
  if (model.cost) info.cost = model.cost;
  return info;
};

export const loadModels = async (): Promise<PublicModelsResponse> => {
  const data = (await getInternalModels()).map(toPublicModel);
  return {
    object: 'list',
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
    data,
  };
};
