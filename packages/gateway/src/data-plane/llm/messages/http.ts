import type { Context } from 'hono';

import { respondMessages } from './respond.ts';
import { messagesServe } from './serve.ts';
import { createNonResponsesSourceStore } from '../responses/items/store.ts';
import { createGatewayCtxFromHono } from '../shared/gateway-ctx.ts';
import { providerModelsUnavailableResponse } from '../shared/upstream-models-error.ts';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import { internalErrorResult, toInternalDebugError } from '@floway-dev/provider';

const parseAnthropicBeta = (raw: string | undefined): readonly string[] | undefined => {
  if (!raw) return undefined;
  const values = raw
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0);
  return values.length > 0 ? values : undefined;
};

// Reject `anthropic_beta` / `betas` in the body; the Messages protocol carries
// them via the `anthropic-beta` HTTP header.
const rejectBodyBetaResponse = (payload: MessagesPayload): Response | null => {
  const record = payload as unknown as Record<string, unknown>;
  const param = Object.hasOwn(record, 'anthropic_beta')
    ? 'anthropic_beta'
    : Object.hasOwn(record, 'betas')
      ? 'betas'
      : null;
  if (!param) return null;
  return Response.json(
    {
      error: {
        message: `${param} in the Messages request body is not supported; send Anthropic beta flags with the anthropic-beta HTTP header.`,
        type: 'invalid_request_error',
        param,
      },
    },
    { status: 400 },
  );
};

// Surfaces a pre-stream throw (malformed JSON body, an interceptor crash,
// etc.) as a Messages-shaped 502 with the same internal-error envelope the
// in-flow `internal-error` ExecuteResult produces. Anything that escapes
// the data plane through Hono's onError is a programmer error, not a user-
// visible failure mode.
const respondWithInternalError = async (c: Context, error: unknown): Promise<Response> => {
  const verbatim = providerModelsUnavailableResponse(error);
  if (verbatim !== null) return verbatim;
  const ctx = createGatewayCtxFromHono(c, false);
  const result = internalErrorResult(502, toInternalDebugError(error, 'messages'));
  const { response } = await respondMessages(c, result, false, ctx);
  return response;
};

export const messagesHttp = {
  generate: async (c: Context): Promise<Response> => {
    try {
      const payload = await c.req.json<MessagesPayload>();
      const rejected = rejectBodyBetaResponse(payload);
      if (rejected) return rejected;

      const wantsStream = payload.stream === true;
      const ctx = createGatewayCtxFromHono(c, wantsStream);
      const store = createNonResponsesSourceStore(ctx.apiKeyId);
      const anthropicBeta = parseAnthropicBeta(c.req.header('anthropic-beta'));
      const result = await messagesServe.generate({ payload, ctx, store, anthropicBeta });
      const { response } = await respondMessages(c, result, wantsStream, ctx);
      return response;
    } catch (error) {
      return await respondWithInternalError(c, error);
    }
  },

  countTokens: async (c: Context): Promise<Response> => {
    try {
      const payload = await c.req.json<MessagesPayload>();
      const rejected = rejectBodyBetaResponse(payload);
      if (rejected) return rejected;

      const ctx = createGatewayCtxFromHono(c, false);
      const store = createNonResponsesSourceStore(ctx.apiKeyId);
      const anthropicBeta = parseAnthropicBeta(c.req.header('anthropic-beta'));
      const result = await messagesServe.countTokens({ payload, ctx, store, anthropicBeta });
      const { response } = await respondMessages(c, result, false, ctx);
      return response;
    } catch (error) {
      return await respondWithInternalError(c, error);
    }
  },
};
