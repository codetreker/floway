// Usage tracking middleware — intercepts responses to extract token usage
// without modifying route handlers

import type { Context, Next } from "hono";
import { recordUsage } from "../lib/usage-tracker.ts";
import { touchApiKeyLastUsed } from "../lib/api-keys.ts";
import {
  getUsageResponseMetadata,
  type UsageResponseMetadata,
} from "./usage-response-metadata.ts";

const PROXY_SUFFIXES = [
  "/messages",
  "/chat/completions",
  "/responses",
  "/embeddings",
];

function isProxyPath(path: string): boolean {
  if (PROXY_SUFFIXES.some((s) => path === s || path === `/v1${s}`)) {
    return true;
  }
  // Gemini generation routes are /v1beta/models/<model>:generateContent or
  // :streamGenerateContent. The :countTokens variant is not billable usage.
  if (path.startsWith("/v1beta/models/")) {
    return path.endsWith(":generateContent") ||
      path.endsWith(":streamGenerateContent");
  }
  return false;
}

export const usageMiddleware = async (c: Context, next: Next) => {
  if (!isProxyPath(c.req.path) || c.req.method !== "POST") {
    return next();
  }

  await next();

  const metadata = getUsageResponseMetadata(c);

  const keyId: string | undefined = c.get("apiKeyId");
  if (!keyId) return;

  const contentType = c.res.headers.get("content-type") ?? "";
  const status = c.res.status;
  if (status < 200 || status >= 300) return; // skip error responses

  if (contentType.includes("text/event-stream")) {
    interceptStreaming(c, keyId, metadata);
  } else {
    await interceptNonStreaming(c, keyId, metadata?.usageModel);
  }
};

async function interceptNonStreaming(
  c: Context,
  keyId: string,
  usageModel: string | undefined,
): Promise<void> {
  const original = c.res;
  const cloned = original.clone();
  // deno-lint-ignore no-explicit-any
  let json: any;
  try {
    json = await cloned.json();
  } catch (error) {
    throw new Error("Usage response is not valid JSON", { cause: error });
  }

  const usage = extractUsageFromJson(json);
  if (usage) {
    const model = requireUsageModel(usageModel ?? extractModelFromJson(json));
    await persistUsage(keyId, model, usage);
  }
}

function interceptStreaming(
  c: Context,
  keyId: string,
  metadata: UsageResponseMetadata | undefined,
): void {
  const original = c.res;
  const body = original.body;
  if (!body) return;

  const usage: UsageInfo = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    model: metadata?.usageModel,
  };
  let gotInputFromStart = false;
  let buffer = "";
  const decoder = new TextDecoder();

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);

      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        gotInputFromStart = consumeUsageLine(line, usage, gotInputFromStart);
      }
    },
    async flush() {
      buffer += decoder.decode();
      if (buffer) {
        gotInputFromStart = consumeUsageLine(buffer, usage, gotInputFromStart);
      }

      applyHiddenChatStreamUsage(metadata, usage);

      if (usage.input > 0 || usage.output > 0) {
        const model = requireUsageModel(usage.model);
        await persistUsage(keyId, model, usage);
      }
    },
  });

  const newBody = body.pipeThrough(transform);
  c.res = new Response(newBody, {
    status: original.status,
    headers: original.headers,
  });
}

interface UsageInfo {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  model?: string;
}

interface StreamUsageInfo extends UsageInfo {
  kind: "messages-start" | "messages-delta" | "final";
  fromStart: boolean;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object"
    ? value as JsonObject
    : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requireUsageModel(model: string | null | undefined): string {
  if (model) return model;
  throw new Error("Usage response has token usage but no model");
}

const persistUsage = async (
  keyId: string,
  model: string,
  usage: UsageInfo,
): Promise<void> => {
  await Promise.all([
    recordUsage(
      keyId,
      model,
      usage.input,
      usage.output,
      usage.cacheRead,
      usage.cacheCreation,
    ),
    touchApiKeyLastUsed(keyId),
  ]);
};

// Successful source-shaped responses carry the model that actually produced
// the usage. Use that structured output instead of a request-context side
// channel so accounting follows alias resolution and translated paths.
function extractModelFromJson(json: unknown): string | null {
  const payload = asObject(json);
  return readString(payload?.model);
}

function extractModelFromStreamEvent(parsed: unknown): string | null {
  const payload = asObject(parsed);
  if (!payload) return null;

  return readString(payload.model) ??
    readString(asObject(payload.message)?.model) ??
    readString(asObject(payload.response)?.model);
}

function setInputUsage(total: UsageInfo, next: UsageInfo): void {
  total.input = next.input;
  total.cacheRead = next.cacheRead;
  total.cacheCreation = next.cacheCreation;
}

// Streaming usage events are cumulative/final snapshots, not additive deltas.
// Anthropic documents message_delta usage as cumulative, and OpenAI Chat
// include_usage chunks report usage for the entire request. Responses terminal
// events carry the completed/incomplete response object, so treat those as final.
// References:
// https://platform.claude.com/docs/en/build-with-claude/streaming
// https://platform.openai.com/docs/api-reference/chat/create#chat-create-stream_options
// https://platform.openai.com/docs/guides/streaming-responses
function mergeStreamUsage(total: UsageInfo, next: StreamUsageInfo): void {
  if (next.kind === "messages-start") {
    setInputUsage(total, next);
    return;
  }

  if (next.kind === "messages-delta") {
    if (next.input > 0) setInputUsage(total, next);
    total.output = next.output;
    return;
  }

  setInputUsage(total, next);
  total.output = next.output;
}

function applyHiddenChatStreamUsage(
  metadata: UsageResponseMetadata | undefined,
  usage: UsageInfo,
): void {
  const hiddenUsage = metadata?.hiddenChatStreamUsageCapture?.usage;
  if (!hiddenUsage) return;
  if (usage.input > 0 || usage.output > 0) return;

  usage.input = hiddenUsage.prompt_tokens;
  usage.output = hiddenUsage.completion_tokens;
  usage.cacheRead = hiddenUsage.prompt_tokens_details?.cached_tokens ?? 0;
  usage.cacheCreation = 0;
}

function consumeUsageLine(
  line: string,
  usage: UsageInfo,
  gotInputFromStart: boolean,
): boolean {
  if (!line.startsWith("data: ")) return gotInputFromStart;

  const data = line.slice(6).trim();
  if (!data || data === "[DONE]") return gotInputFromStart;

  const parsed = JSON.parse(data);
  usage.model ??= extractModelFromStreamEvent(parsed) ?? undefined;
  const extracted = extractUsageFromStreamEvent(parsed, gotInputFromStart);
  if (!extracted) return gotInputFromStart;

  mergeStreamUsage(usage, extracted);
  return gotInputFromStart || extracted.fromStart;
}

// deno-lint-ignore no-explicit-any
function extractUsageFromJson(json: any): UsageInfo | null {
  if (json?.usageMetadata?.promptTokenCount != null) {
    return geminiUsageFromMetadata(json.usageMetadata);
  }

  if (json?.usage?.input_tokens != null) {
    // Responses non-stream replies share usage.input_tokens with Messages but
    // use OpenAI semantics: input_tokens already includes cached_tokens, and
    // there is no cache-write concept. Discriminate by input_tokens_details,
    // which only Responses populates.
    if (json.usage.input_tokens_details) {
      return {
        input: json.usage.input_tokens,
        output: json.usage.output_tokens ?? 0,
        cacheRead: json.usage.input_tokens_details.cached_tokens ?? 0,
        cacheCreation: 0,
      };
    }

    const cacheRead = json.usage.cache_read_input_tokens ?? 0;
    const cacheCreation = json.usage.cache_creation_input_tokens ?? 0;
    return {
      input: json.usage.input_tokens + cacheRead + cacheCreation,
      output: json.usage.output_tokens ?? 0,
      cacheRead,
      cacheCreation,
    };
  }

  if (json?.usage?.prompt_tokens != null) {
    return {
      input: json.usage.prompt_tokens,
      output: json.usage.completion_tokens ?? 0,
      cacheRead: json.usage.prompt_tokens_details?.cached_tokens ?? 0,
      cacheCreation: 0,
    };
  }

  return null;
}

function extractUsageFromStreamEvent(
  parsed: unknown,
  gotInputFromStart: boolean,
): StreamUsageInfo | null {
  const payload = asObject(parsed);
  if (!payload) return null;

  if (payload.type === "message_start") {
    const message = asObject(payload.message);
    const usage = asObject(message?.usage);
    if (!usage) return null;

    const cacheRead = readNumber(usage.cache_read_input_tokens) ?? 0;
    const cacheCreation = readNumber(usage.cache_creation_input_tokens) ?? 0;
    const input = (readNumber(usage.input_tokens) ?? 0) + cacheRead +
      cacheCreation;
    return input > 0
      ? {
        kind: "messages-start",
        input,
        output: 0,
        cacheRead,
        cacheCreation,
        fromStart: true,
      }
      : null;
  }

  // In translated streams targeting Messages, the message_start may have
  // input_tokens=0 because the upstream usage-only chunk arrives after the
  // first chunk. The usage-only chunk generates a supplemental message_delta
  // carrying both input_tokens and output_tokens. We only extract input_tokens
  // from message_delta when message_start didn't already provide them.
  if (payload.type === "message_delta") {
    const usage = asObject(payload.usage);
    if (!usage) return null;
    const output = readNumber(usage.output_tokens);
    if (output == null) return null;

    let input = 0;
    let cacheRead = 0;
    let cacheCreation = 0;
    if (!gotInputFromStart && readNumber(usage.input_tokens) != null) {
      cacheRead = readNumber(usage.cache_read_input_tokens) ?? 0;
      cacheCreation = readNumber(usage.cache_creation_input_tokens) ?? 0;
      input = (readNumber(usage.input_tokens) ?? 0) + cacheRead + cacheCreation;
    }
    return {
      kind: "messages-delta",
      input,
      output,
      cacheRead,
      cacheCreation,
      fromStart: false,
    };
  }

  if (
    payload.type === "response.completed" ||
    payload.type === "response.incomplete"
  ) {
    const response = asObject(payload.response);
    const usage = asObject(response?.usage);
    if (!usage) return null;
    const details = asObject(usage.input_tokens_details);
    return {
      kind: "final",
      input: readNumber(usage.input_tokens) ?? 0,
      output: readNumber(usage.output_tokens) ?? 0,
      cacheRead: readNumber(details?.cached_tokens) ?? 0,
      cacheCreation: 0,
      fromStart: false,
    };
  }

  const usage = asObject(payload.usage);
  if (readNumber(usage?.prompt_tokens) != null) {
    const details = asObject(usage?.prompt_tokens_details);
    return {
      kind: "final",
      input: readNumber(usage?.prompt_tokens) ?? 0,
      output: readNumber(usage?.completion_tokens) ?? 0,
      cacheRead: readNumber(details?.cached_tokens) ?? 0,
      cacheCreation: 0,
      fromStart: false,
    };
  }

  const geminiUsage = asObject(payload.usageMetadata);
  if (geminiUsage && readNumber(geminiUsage.promptTokenCount) != null) {
    const info = geminiUsageFromMetadata(geminiUsage);
    return {
      kind: "final",
      input: info.input,
      output: info.output,
      cacheRead: info.cacheRead,
      cacheCreation: info.cacheCreation,
      fromStart: false,
    };
  }

  return null;
}

// Gemini usageMetadata.promptTokenCount already includes cachedContentTokenCount,
// matching OpenAI semantics. thoughtsTokenCount is reasoning output that is NOT
// counted inside candidatesTokenCount, so include it in our output total to keep
// per-key billing consistent with Anthropic/OpenAI which fold reasoning tokens
// into output_tokens / completion_tokens.
function geminiUsageFromMetadata(metadata: JsonObject): UsageInfo {
  const promptTokenCount = readNumber(metadata.promptTokenCount) ?? 0;
  const candidatesTokenCount = readNumber(metadata.candidatesTokenCount) ?? 0;
  const thoughtsTokenCount = readNumber(metadata.thoughtsTokenCount) ?? 0;
  return {
    input: promptTokenCount,
    output: candidatesTokenCount + thoughtsTokenCount,
    cacheRead: readNumber(metadata.cachedContentTokenCount) ?? 0,
    cacheCreation: 0,
  };
}
