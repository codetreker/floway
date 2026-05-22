import type { RawModelMetadata, RawModelsResponse } from '../model-info.ts';

export type CopilotRawModel = RawModelMetadata;

export type CopilotModelsResponse = RawModelsResponse<CopilotRawModel>;
