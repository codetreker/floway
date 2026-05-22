import type { ModelMetadata } from './types.ts';

export interface RawModelMetadata {
  id: string;
  object?: string;
  name?: string;
  version?: string;
  owned_by?: string;
  created?: number;
  display_name?: string;
  created_at?: string;
  description?: string;
  supported_endpoints?: string[];
  capabilities?: {
    family?: string;
    type?: string;
    limits?: {
      max_context_window_tokens?: number;
      max_non_streaming_output_tokens?: number;
      max_prompt_tokens?: number;
      max_output_tokens?: number;
    };
    supports?: {
      tool_calls?: boolean;
      parallel_tool_calls?: boolean;
      streaming?: boolean;
      vision?: boolean;
      adaptive_thinking?: boolean;
      reasoning_effort?: string[];
    };
  };
  supports_generation?: boolean;
  model_picker_enabled?: boolean;
  billing?: {
    is_premium?: boolean;
    multiplier?: number;
    restricted_to?: string[];
  };
  policy?: {
    state?: string;
    terms?: string;
  };
}

export interface RawModelsResponse<TModel extends RawModelMetadata = RawModelMetadata> {
  object: string;
  data: TModel[];
}

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
