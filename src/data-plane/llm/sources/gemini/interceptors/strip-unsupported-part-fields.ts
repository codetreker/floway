import type { GeminiGenerateContentRequest, GeminiPart } from '../../../../shared/protocol/gemini.ts';
import type { GeminiInterceptor } from '../../../interceptors.ts';

/**
 * Gemini file/code parts have no current equivalent in the upstream target
 * graph. Drop them at source so every Gemini route target sees translatable
 * parts.
 */
const stripPartFields = (parts: GeminiPart[]): GeminiPart[] =>
  parts.filter(part => {
    delete part.fileData;
    delete part.executableCode;
    delete part.codeExecutionResult;
    return Object.keys(part).length > 0;
  });

export const stripUnsupportedPartFieldsFromPayload = (payload: GeminiGenerateContentRequest): void => {
  payload.contents?.forEach(content => {
    content.parts = stripPartFields(content.parts);
  });
  if (payload.systemInstruction) {
    payload.systemInstruction.parts = stripPartFields(payload.systemInstruction.parts);
  }
};

export const stripUnsupportedPartFields: GeminiInterceptor = (ctx, run) => {
  stripUnsupportedPartFieldsFromPayload(ctx.payload);
  return run();
};
