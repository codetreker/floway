export interface ModelInfo {
  id: string;
  object: string;
  owned_by?: string;
  created?: number;
}

export interface ModelsResponse {
  object: string;
  data: ModelInfo[];
}

export interface AnthropicModelInfo {
  id: string;
  type: 'model';
  display_name: string;
  created_at?: string;
}

export interface AnthropicModelsResponse {
  data: AnthropicModelInfo[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}
