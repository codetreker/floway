import type { LlmSourceApi, LlmTargetApi } from '../../interceptors.ts';

// Embeddings is not part of the LLM source-routing graph but uses the same
// debug envelope when its handler fails; widen at this boundary only.
type DebugSourceApi = LlmSourceApi | 'embeddings';

export interface InternalDebugError {
  type: 'internal_error';
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
  source_api: DebugSourceApi;
  target_api?: LlmTargetApi;
}

const serializeCause = (cause: unknown): unknown => {
  if (!(cause instanceof Error)) return cause;

  return {
    name: cause.name,
    message: cause.message,
    stack: cause.stack,
    cause: serializeCause(cause.cause),
  };
};

export const toInternalDebugError = (error: unknown, sourceApi: DebugSourceApi, targetApi?: LlmTargetApi): InternalDebugError => {
  const known = error instanceof Error ? error : new Error(String(error));

  return {
    type: 'internal_error',
    name: known.name,
    message: known.message,
    stack: known.stack,
    cause: serializeCause(known.cause),
    source_api: sourceApi,
    ...(targetApi ? { target_api: targetApi } : {}),
  };
};
