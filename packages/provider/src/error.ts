// Errors that bubble out of source/target emit or interceptors and need a
// structured envelope for the api debug response. Provider/source api lanes
// are typed as a free string here so the package stays decoupled from the
// api-internal serve-api unions — the api always passes the narrowed values
// it owns.
export type DebugSourceApi = string;

export interface InternalDebugError {
  type: 'internal_error';
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
  source_api: DebugSourceApi;
  target_api?: string;
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

export const toInternalDebugError = (error: unknown, sourceApi: DebugSourceApi, targetApi?: string): InternalDebugError => {
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
