import {
  findModelInModels,
  loadModels,
  type ModelInfo,
} from "../../../models/cache.ts";

export interface ModelCapabilities {
  maxOutputTokens?: number;
  supportsMessages: boolean;
  supportsResponses: boolean;
  supportsChatCompletions: boolean;
  supportsAdaptiveThinking: boolean;
  // True when the upstream model metadata explicitly declared its endpoint
  // surface. Legacy fallback routing is only valid when Copilot omitted this
  // field entirely for older chat SKUs.
  hasExplicitCapabilities: boolean;
}

// Copilot's /models response only annotates supported_endpoints on newer
// entries (Claude family, GPT-5/Codex family, Gemini 3 preview). Legacy chat
// models (gpt-4o, gpt-4.1, gpt-4o-mini, gemini-2.5-pro, …) omit the field
// entirely. Treating the omission as "no endpoints supported" makes every
// source's plan() return null and surfaces the gateway-internal "Model X does
// not support the /<endpoint> endpoint." error. Copilot has always served
// those legacy chat models from /chat/completions, so when the array is
// missing we infer chat support from capabilities.type === "chat" and leave
// the explicit-array path strict so an upstream-declared empty list is still
// honored.
const inferredChatCompletionsSupport = (
  model: ModelInfo | undefined,
): boolean =>
  model !== undefined &&
  model.supported_endpoints === undefined &&
  model.capabilities?.type === "chat";

export const modelCapabilitiesFromModel = (
  model: ModelInfo | undefined,
): ModelCapabilities => {
  const supportedEndpoints = model?.supported_endpoints ?? [];

  return {
    maxOutputTokens: model?.capabilities?.limits?.max_output_tokens,
    supportsMessages: supportedEndpoints.includes("/v1/messages"),
    supportsResponses: supportedEndpoints.includes("/responses"),
    supportsChatCompletions: supportedEndpoints.includes("/chat/completions") ||
      inferredChatCompletionsSupport(model),
    supportsAdaptiveThinking:
      model?.capabilities?.supports?.adaptive_thinking === true,
    hasExplicitCapabilities: model?.supported_endpoints !== undefined,
  };
};

export const getModelCapabilities = async (
  modelId: string,
  githubToken: string,
  accountType: string,
): Promise<ModelCapabilities> => {
  const result = await loadModels(githubToken, accountType);
  if (result.type === "error") throw result.error;

  const model = findModelInModels(result.data, modelId);
  return modelCapabilitiesFromModel(model);
};
