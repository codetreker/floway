import type { AnthropicModelInfo, AnthropicModelsResponse, ModelInfo, ModelsResponse } from './types.ts';
import { getCatalogModels } from '../providers/registry.ts';
import type { CatalogModel } from '../providers/types.ts';

export const toPublicModelInfo = (model: CatalogModel): ModelInfo => {
  return {
    id: model.id,
    object: model.object,
    ...(model.owned_by !== undefined ? { owned_by: model.owned_by } : {}),
    ...(model.created !== undefined ? { created: model.created } : {}),
  };
};

export const toAnthropicModelInfo = (model: CatalogModel): AnthropicModelInfo => {
  const createdAt = model.created_at ?? (model.created !== undefined ? new Date(model.created * 1000).toISOString() : undefined);
  return {
    id: model.id,
    type: 'model',
    display_name: model.display_name ?? model.name ?? model.id,
    ...(createdAt !== undefined ? { created_at: createdAt } : {}),
  };
};

export const loadMergedModels = async (): Promise<ModelsResponse> => {
  const models = await getCatalogModels();
  return {
    object: 'list',
    data: models.map(toPublicModelInfo),
  };
};

export const loadAnthropicModels = async (): Promise<AnthropicModelsResponse> => {
  const data = (await getCatalogModels()).filter(model => model.supports_generation).map(toAnthropicModelInfo);
  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  };
};
