// Copilot's `/models` wire shape. Lives here (not in the provider-neutral
// layer) because no other provider consumes these fields — `capabilities.type`
// and `supports.reasoning_effort` are read by Copilot's raw variant selector,
// the rest is upstream metadata we ignore.

export interface CopilotRawModel {
  id: string;
  name?: string;
  version?: string;
  owned_by?: string;
  created?: number;
  display_name?: string;
  supported_endpoints?: string[];
  capabilities?: {
    type?: string;
    limits?: {
      max_context_window_tokens?: number;
      max_prompt_tokens?: number;
      max_output_tokens?: number;
    };
    supports?: {
      reasoning_effort?: string[];
    };
  };
}

export interface CopilotModelsResponse {
  object: string;
  data: CopilotRawModel[];
}
