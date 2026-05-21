import type { CachedModelInfo, CachedModelsResponse } from '../upstream-model-cache.ts';

export type CopilotRawModel = CachedModelInfo;

export type CopilotModelsResponse = CachedModelsResponse<CopilotRawModel>;
