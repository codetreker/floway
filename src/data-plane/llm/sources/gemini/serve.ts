import type { Context } from "hono";
import type {
  GeminiGenerateContentRequest,
  GeminiStreamEvent,
} from "../../shared/protocol/gemini.ts";
import {
  type PerformanceTelemetryContext,
  runtimeLocationFromRequest,
} from "../../../shared/performance/telemetry.ts";
import {
  type GeminiSourceContext,
  geminiSourceInterceptors,
} from "./interceptors/index.ts";
import { runSourceInterceptors } from "../run-interceptors.ts";
import { respondGemini } from "./respond.ts";
import { geminiModelResolutionIntent, planGeminiRequest } from "./plan.ts";
import { getModelCapabilities } from "../../shared/models/get-model-capabilities.ts";
import { resolveModelForRequest } from "../../shared/models/resolve-model.ts";
import { withAccountFallback } from "../../../shared/account-pool/fallback.ts";
import { emitToMessages } from "../../targets/messages/emit.ts";
import { emitToResponses } from "../../targets/responses/emit.ts";
import { emitToChatCompletions } from "../../targets/chat-completions/emit.ts";
import { buildTargetRequest as buildMessagesTargetRequest } from "../../translate/gemini-via-messages/request.ts";
import { buildTargetRequest as buildResponsesTargetRequest } from "../../translate/gemini-via-responses/request.ts";
import { buildTargetRequest as buildChatCompletionsTargetRequest } from "../../translate/gemini-via-chat-completions/request.ts";
import { translateToSourceEvents as translateMessagesToSourceEvents } from "../../translate/gemini-via-messages/events.ts";
import { translateToSourceEvents as translateResponsesToSourceEvents } from "../../translate/gemini-via-responses/events.ts";
import { translateToSourceEvents as translateChatCompletionsToSourceEvents } from "../../translate/gemini-via-chat-completions/events.ts";
import {
  internalErrorResult,
  type StreamExecuteResult,
  type UpstreamErrorResult,
} from "../../shared/errors/result.ts";
import { toInternalDebugError } from "../../shared/errors/internal-debug-error.ts";
import { thrownUpstreamErrorResult } from "../../shared/errors/upstream-error.ts";
import type { ProtocolFrame } from "../../shared/stream/types.ts";
import { backgroundSchedulerFromContext } from "../../../../runtime/background.ts";

const withTranslatedEvents = <T>(
  result: StreamExecuteResult<T>,
  translate: (
    events: AsyncIterable<ProtocolFrame<T>>,
  ) => AsyncIterable<ProtocolFrame<GeminiStreamEvent>>,
): StreamExecuteResult<GeminiStreamEvent> =>
  result.type === "events"
    ? { ...result, events: translate(result.events) }
    : result;

const withResultMetadata = <T>(
  result: StreamExecuteResult<T>,
  usageModel: string,
  performance: PerformanceTelemetryContext,
): StreamExecuteResult<T> =>
  result.type === "events"
    ? { ...result, usageModel, performance }
    : { ...result, performance };

const unsupportedGeminiModelResult = (
  model: string,
  performance: PerformanceTelemetryContext,
): UpstreamErrorResult => ({
  type: "upstream-error",
  status: 400,
  headers: new Headers({ "content-type": "application/json" }),
  body: new TextEncoder().encode(JSON.stringify({
    error: {
      code: 400,
      message:
        `Model ${model} does not support the Gemini generateContent endpoint.`,
      status: "INVALID_ARGUMENT",
    },
  })),
  performance,
});

export const serveGemini = async (
  c: Context,
  model: string,
  wantsStream: boolean,
): Promise<Response> => {
  let lastPerformance: PerformanceTelemetryContext | undefined;
  let downstreamAbortController: AbortController | undefined;
  try {
    const payload = await c.req.json<GeminiGenerateContentRequest>();
    const apiKeyId = c.get("apiKeyId") as string | undefined;
    downstreamAbortController = wantsStream ? new AbortController() : undefined;
    const runtimeLocation = runtimeLocationFromRequest(c.req.raw);
    const scheduleBackground = backgroundSchedulerFromContext(c);
    const ctx: GeminiSourceContext = { payload, apiKeyId };
    const performanceFor = (
      usageModel: string,
      targetApi: PerformanceTelemetryContext["targetApi"],
    ): PerformanceTelemetryContext => {
      lastPerformance = {
        keyId: apiKeyId ?? "unknown",
        model: usageModel,
        sourceApi: "gemini",
        targetApi,
        stream: wantsStream,
        runtimeLocation,
      };
      return lastPerformance;
    };

    const result = await runSourceInterceptors(
      ctx,
      geminiSourceInterceptors,
      async () => {
        const modelId = await resolveModelForRequest(
          model,
          geminiModelResolutionIntent(ctx.payload),
        );
        performanceFor(modelId, "gemini");

        return await withAccountFallback(modelId, async ({ account }) => {
          const attemptPayload = structuredClone(ctx.payload);
          const capabilities = await getModelCapabilities(
            modelId,
            account.token,
            account.accountType,
          );
          const plan = planGeminiRequest(
            attemptPayload,
            modelId,
            capabilities,
          );
          if (!plan) {
            const performance = performanceFor(modelId, "gemini");
            return unsupportedGeminiModelResult(modelId, performance);
          }

          if (plan.target === "messages") {
            const targetPayload = buildMessagesTargetRequest(
              attemptPayload,
              modelId,
              wantsStream,
              capabilities,
            );
            const performance = performanceFor(
              targetPayload.model,
              "messages",
            );
            const result = await emitToMessages({
              sourceApi: "gemini",
              payload: targetPayload,
              githubToken: account.token,
              accountType: account.accountType,
              apiKeyId,
              clientStream: wantsStream,
              runtimeLocation,
              scheduleBackground,
              fetchOptions: plan.fetchOptions,
              downstreamAbortSignal: downstreamAbortController?.signal,
            });

            return withResultMetadata(
              withTranslatedEvents(result, translateMessagesToSourceEvents),
              targetPayload.model,
              performance,
            );
          }

          if (plan.target === "responses") {
            const targetPayload = buildResponsesTargetRequest(
              attemptPayload,
              modelId,
              wantsStream,
            );
            const performance = performanceFor(
              targetPayload.model,
              "responses",
            );
            const result = await emitToResponses({
              sourceApi: "gemini",
              payload: targetPayload,
              githubToken: account.token,
              accountType: account.accountType,
              apiKeyId,
              clientStream: wantsStream,
              runtimeLocation,
              scheduleBackground,
              fetchOptions: plan.fetchOptions,
              downstreamAbortSignal: downstreamAbortController?.signal,
            });

            return withResultMetadata(
              withTranslatedEvents(result, translateResponsesToSourceEvents),
              targetPayload.model,
              performance,
            );
          }

          const targetPayload = buildChatCompletionsTargetRequest(
            attemptPayload,
            modelId,
            wantsStream,
          );
          const performance = performanceFor(
            targetPayload.model,
            "chat-completions",
          );
          const result = await emitToChatCompletions({
            sourceApi: "gemini",
            payload: targetPayload,
            githubToken: account.token,
            accountType: account.accountType,
            apiKeyId,
            clientStream: wantsStream,
            runtimeLocation,
            scheduleBackground,
            fetchOptions: plan.fetchOptions,
            downstreamAbortSignal: downstreamAbortController?.signal,
          });

          return withResultMetadata(
            withTranslatedEvents(
              result,
              translateChatCompletionsToSourceEvents,
            ),
            targetPayload.model,
            performance,
          );
        });
      },
    );

    return await respondGemini(
      c,
      result,
      wantsStream,
      downstreamAbortController,
    );
  } catch (error) {
    const upstreamError = thrownUpstreamErrorResult(error, lastPerformance);
    if (upstreamError) {
      return await respondGemini(
        c,
        upstreamError,
        false,
        downstreamAbortController,
      );
    }

    return await respondGemini(
      c,
      internalErrorResult(
        500,
        toInternalDebugError(error, "gemini"),
        lastPerformance,
      ),
      false,
      downstreamAbortController,
    );
  }
};
