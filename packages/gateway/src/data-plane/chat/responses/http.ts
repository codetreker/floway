import { translatorInputErrorResult } from './errors.ts';
import { createResponsesHttpStore } from './items/store.ts';
import { respondResponses } from './respond.ts';
import { PreviousResponseNotFoundError } from './serve-prep.ts';
import { responsesServe } from './serve.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { CODEX_AUTO_REVIEW_ALIAS, CODEX_AUTO_REVIEW_TARGET } from '../../codex/auto-review-alias.ts';
import { inboundHeadersForUpstream } from '../../shared/inbound-headers.ts';
import { createChatGatewayCtxFromHono, createGatewayCtxFromHono, type ChatGatewayCtx, type GatewayCtx } from '../shared/gateway-ctx.ts';
import { readRequestBody, type RequestBody } from '../shared/request-body.ts';
import { providerModelsUnavailableResponse } from '../shared/upstream-models-error.ts';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { internalErrorResult, toInternalDebugError } from '@floway-dev/provider';
import { TranslatorInputError } from '@floway-dev/translate';

// Codex sends auto-review requests over the Responses wire API as a
// `codex-auto-review` model id; rewrite at the entry so downstream routing,
// performance telemetry, and usage accounting all see the real model name
// (and the `low` reasoning effort the alias implies — generate only;
// compact carries no `reasoning` field).
const rewriteResponsesEntryModelAlias = (payload: ResponsesPayload, stampReasoningEffort: boolean): ResponsesPayload => {
  if (payload.model !== CODEX_AUTO_REVIEW_ALIAS) return payload;
  if (!stampReasoningEffort) return { ...payload, model: CODEX_AUTO_REVIEW_TARGET };
  return {
    ...payload,
    model: CODEX_AUTO_REVIEW_TARGET,
    reasoning: { ...(payload.reasoning ?? {}), effort: 'low' },
  };
};

// OpenAI's verbatim previous_response_not_found envelope. Codex compares this
// body byte-for-byte against upstream — see the cross-references on
// `PreviousResponseNotFoundError` in serve-prep.ts.
const previousResponseNotFoundResponse = (id: string): Response =>
  Response.json(
    {
      error: {
        message: `Previous response with id '${id}' not found.`,
        type: 'invalid_request_error',
        param: 'previous_response_id',
        code: 'previous_response_not_found',
      },
    },
    { status: 400 },
  );

// Surfaces a pre-stream throw (malformed JSON body, an interceptor crash,
// etc.) as a Responses-shaped 502 with the same internal-error envelope the
// in-flow `internal-error` ExecuteResult produces. A
// `ProviderModelsUnavailableError` carrying an upstream HTTP body relays
// that body verbatim — the upstream's `/models` 401 IS the diagnostic. The
// caller passes its outer `ctx` when one was already constructed (so the
// dump row preserves the model attribution the request-time
// `requestedModel` stamped); a fresh ctx is minted only for pre-parse
// failures where no payload was available to read model from.
const respondWithInternalError = async (c: AuthedContext, error: unknown, requestBody: RequestBody, ctx?: GatewayCtx): Promise<Response> => {
  const verbatim = providerModelsUnavailableResponse(error);
  if (verbatim !== null) return verbatim;
  const effectiveCtx = ctx ?? createGatewayCtxFromHono(c, { wantsStream: false, requestBody });
  const result = internalErrorResult(502, toInternalDebugError(error));
  const { response } = await respondResponses(c, result, false, effectiveCtx);
  return (effectiveCtx.dump?.finalize(response) ?? response);
};

// Pre-stream throw dispatcher. `PreviousResponseNotFoundError` and the
// translator-input case render protocol-shaped 400s; anything else falls
// through to the internal-error 502 path.
const respondToThrow = async (c: AuthedContext, error: unknown, requestBody: RequestBody, ctx?: GatewayCtx): Promise<Response> => {
  if (error instanceof PreviousResponseNotFoundError) {
    const response = previousResponseNotFoundResponse(error.previousResponseId);
    ctx?.dump?.error('gateway');
    return (ctx?.dump?.finalize(response) ?? response);
  }
  if (error instanceof TranslatorInputError) {
    const effectiveCtx = ctx ?? createGatewayCtxFromHono(c, { wantsStream: false, requestBody });
    const { response } = await respondResponses(c, translatorInputErrorResult(error), false, effectiveCtx);
    return (effectiveCtx.dump?.finalize(response) ?? response);
  }
  return await respondWithInternalError(c, error, requestBody, ctx);
};

const parsePayload = (requestBody: RequestBody, stampReasoningEffort: boolean): ResponsesPayload =>
  rewriteResponsesEntryModelAlias(JSON.parse(new TextDecoder().decode(requestBody.bytes)) as ResponsesPayload, stampReasoningEffort);

export const responsesHttp = {
  generate: async (c: AuthedContext): Promise<Response> => {
    const requestBody = await readRequestBody(c);
    let ctx: ChatGatewayCtx | undefined;
    try {
      const payload = parsePayload(requestBody, true);
      const wantsStream = payload.stream === true;
      ctx = createChatGatewayCtxFromHono(c, { wantsStream, requestBody, model: payload.model }, apiKeyId => createResponsesHttpStore(apiKeyId, payload.store ?? undefined));
      const result = await responsesServe.generate({ payload, ctx, headers: inboundHeadersForUpstream(c) });
      const { response } = await respondResponses(c, result, wantsStream, ctx);
      return (ctx.dump?.finalize(response) ?? response);
    } catch (error) {
      return await respondToThrow(c, error, requestBody, ctx);
    }
  },

  compact: async (c: AuthedContext): Promise<Response> => {
    const requestBody = await readRequestBody(c);
    let ctx: ChatGatewayCtx | undefined;
    try {
      const payload = parsePayload(requestBody, false);
      ctx = createChatGatewayCtxFromHono(c, { wantsStream: false, requestBody, model: payload.model }, apiKeyId => createResponsesHttpStore(apiKeyId, payload.store ?? undefined));
      const result = await responsesServe.compact({ payload, ctx, headers: inboundHeadersForUpstream(c) });
      if (result.type === 'result') {
        ctx.dump?.success(result.modelIdentity, result.usage);
        const compactResponse = Response.json(result.result);
        return (ctx.dump?.finalize(compactResponse) ?? compactResponse);
      }
      const { response } = await respondResponses(c, result, false, ctx);
      return (ctx.dump?.finalize(response) ?? response);
    } catch (error) {
      return await respondToThrow(c, error, requestBody, ctx);
    }
  },
};
