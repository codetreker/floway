import type { Context } from 'hono';

import { respondChatCompletions } from './respond.ts';
import { chatCompletionsServe } from './serve.ts';
import { createNonResponsesSourceStore } from '../responses/items/store.ts';
import { createGatewayCtxFromHono } from '../shared/gateway-ctx.ts';
import { providerModelsUnavailableResponse } from '../shared/upstream-models-error.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import { internalErrorResult, toInternalDebugError } from '@floway-dev/provider';

// Surfaces a pre-stream throw (malformed JSON body, an interceptor crash,
// etc.) as a Chat Completions-shaped 502 with the same internal-error
// envelope the in-flow `internal-error` ExecuteResult produces. A
// `ProviderModelsUnavailableError` carrying an upstream HTTP body relays
// that body verbatim — the upstream's `/models` 401 IS the diagnostic.
const respondWithInternalError = async (c: Context, error: unknown): Promise<Response> => {
  const verbatim = providerModelsUnavailableResponse(error);
  if (verbatim !== null) return verbatim;
  const ctx = createGatewayCtxFromHono(c, false);
  const result = internalErrorResult(502, toInternalDebugError(error, 'chat-completions'));
  const { response } = await respondChatCompletions(c, result, false, false, ctx);
  return response;
};

export const chatCompletionsHttp = {
  generate: async (c: Context): Promise<Response> => {
    try {
      const payload = await c.req.json<ChatCompletionsPayload>();
      const wantsStream = payload.stream === true;
      // Read the caller's intent BEFORE any interceptor mutates
      // `payload.stream_options.include_usage`. Capturing it here means the
      // downstream renderer never needs to consult per-request Hono context
      // slots — the value lives in this http-entry closure for the duration of
      // the request.
      const includeUsageChunk = payload.stream_options?.include_usage === true;
      const ctx = createGatewayCtxFromHono(c, wantsStream);
      const store = createNonResponsesSourceStore(ctx.apiKeyId);
      const result = await chatCompletionsServe.generate({ payload, ctx, store });
      const { response } = await respondChatCompletions(c, result, wantsStream, includeUsageChunk, ctx);
      return response;
    } catch (error) {
      return await respondWithInternalError(c, error);
    }
  },
};
