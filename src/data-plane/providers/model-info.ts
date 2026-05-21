import type { ModelMetadata } from './types.ts';
import type { CachedModelInfo } from './upstream-model-cache.ts';

export type RawModelMetadata = CachedModelInfo;

export const withModelInfoDefaults = (model: RawModelMetadata): ModelMetadata => {
  const metadata: ModelMetadata = {
    object: model.object ?? 'model',
    id: model.id,
    name: model.name ?? model.id,
    version: model.version ?? model.id,
    capabilities: {
      family: model.capabilities?.family ?? model.id,
      type: model.capabilities?.type ?? 'chat',
      limits: model.capabilities?.limits ?? {},
      supports: model.capabilities?.supports ?? {},
    },
  };

  if (model.billing) metadata.billing = model.billing;
  if (model.policy) metadata.policy = model.policy;
  if (model.owned_by !== undefined) metadata.owned_by = model.owned_by;
  if (model.created !== undefined) metadata.created = model.created;
  if (model.display_name !== undefined) {
    metadata.display_name = model.display_name;
  }
  if (model.created_at !== undefined) metadata.created_at = model.created_at;
  if (model.description !== undefined) metadata.description = model.description;
  if (model.model_picker_enabled !== undefined) {
    metadata.model_picker_enabled = model.model_picker_enabled;
  }
  return metadata;
};
