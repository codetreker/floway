import { captureExtras } from '../../../../shared/reassemble-extras.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiCandidate, GeminiErrorResponse, GeminiResult, GeminiPart, GeminiStreamEvent } from '@floway-dev/protocols/gemini';

export const GEMINI_MISSING_TERMINAL_MESSAGE = 'Gemini stream ended without a terminal event.';

export const isGeminiErrorEvent = (event: GeminiStreamEvent): event is GeminiErrorResponse => 'error' in event;

const isGeminiFinishedEvent = (event: GeminiStreamEvent): boolean => 'candidates' in event && event.candidates?.some(candidate => candidate.finishReason !== undefined) === true;

export const isGeminiTerminalEvent = (event: GeminiStreamEvent): boolean => isGeminiErrorEvent(event) || isGeminiFinishedEvent(event);

// Field-fidelity contract — see {@link captureExtras}. The typed paths above
// accumulate the fields we understand (parts, role, finishReason, top-level
// modelVersion / responseId / usageMetadata); the key sets below name those
// known fields so anything else an upstream emits — `safetyRatings`,
// `groundingMetadata`, `citationMetadata`, future Gemini extensions, etc. —
// survives onto the assembled result.
const KNOWN_RESULT_KEYS = new Set(['candidates', 'modelVersion', 'responseId', 'usageMetadata']);
const KNOWN_CANDIDATE_KEYS = new Set(['index', 'content', 'finishReason']);

const isMergeableTextPart = (part: GeminiPart): boolean =>
  part.text !== undefined
  && part.thought !== true
  && part.thoughtSignature === undefined
  && part.inlineData === undefined
  && part.functionCall === undefined
  && part.functionResponse === undefined
  && part.fileData === undefined
  && part.executableCode === undefined
  && part.codeExecutionResult === undefined;

const appendPart = (parts: GeminiPart[], part: GeminiPart): void => {
  const previous = parts.at(-1);
  if (previous && isMergeableTextPart(previous) && isMergeableTextPart(part)) {
    previous.text = `${previous.text}${part.text}`;
    return;
  }

  parts.push({ ...part });
};

interface GeminiCandidateWithExtras extends GeminiCandidate {
  __extras?: Record<string, unknown>;
}

const mergeCandidate = (candidates: Map<number, GeminiCandidateWithExtras>, incoming: GeminiCandidate): void => {
  const existing = candidates.get(incoming.index);
  if (!existing) {
    const candidate: GeminiCandidateWithExtras = {
      index: incoming.index,
      content: {
        ...(incoming.content.role !== undefined ? { role: incoming.content.role } : {}),
        parts: [],
      },
      ...(incoming.finishReason !== undefined ? { finishReason: incoming.finishReason } : {}),
    };
    for (const part of incoming.content.parts) {
      appendPart(candidate.content.parts, part);
    }
    const extras: Record<string, unknown> = {};
    captureExtras(incoming as unknown as Record<string, unknown>, KNOWN_CANDIDATE_KEYS, extras);
    if (Object.keys(extras).length > 0) candidate.__extras = extras;
    candidates.set(incoming.index, candidate);
    return;
  }

  if (incoming.content.role !== undefined) {
    existing.content.role = incoming.content.role;
  }
  for (const part of incoming.content.parts) {
    appendPart(existing.content.parts, part);
  }
  if (incoming.finishReason !== undefined) {
    existing.finishReason = incoming.finishReason;
  }
  const extras = existing.__extras ?? {};
  captureExtras(incoming as unknown as Record<string, unknown>, KNOWN_CANDIDATE_KEYS, extras);
  if (Object.keys(extras).length > 0) existing.__extras = extras;
};

const finalizeCandidate = (candidate: GeminiCandidateWithExtras): GeminiCandidate => {
  const { __extras: extras, ...rest } = candidate;
  return extras ? ({ ...rest, ...extras } as GeminiCandidate) : (rest as GeminiCandidate);
};

export const collectGeminiProtocolEventsToResult = async (frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>): Promise<GeminiResult> => {
  const candidates = new Map<number, GeminiCandidateWithExtras>();
  const result: GeminiResult = {};
  const resultExtras: Record<string, unknown> = {};
  let completed = false;

  for await (const frame of frames) {
    if (frame.type === 'done') {
      completed = true;
      break;
    }

    const event = frame.event;
    if (isGeminiErrorEvent(event)) {
      throw new Error(`${event.error.status}: ${event.error.message}`, {
        cause: event,
      });
    }

    for (const candidate of event.candidates ?? []) {
      mergeCandidate(candidates, candidate);
    }

    if (event.modelVersion !== undefined) result.modelVersion = event.modelVersion;
    if (event.responseId !== undefined) result.responseId = event.responseId;
    if (event.usageMetadata !== undefined) result.usageMetadata = event.usageMetadata;
    captureExtras(event as unknown as Record<string, unknown>, KNOWN_RESULT_KEYS, resultExtras);

    if (isGeminiTerminalEvent(event)) {
      completed = true;
      break;
    }
  }

  if (!completed) {
    throw new Error(GEMINI_MISSING_TERMINAL_MESSAGE);
  }

  const mergedCandidates = [...candidates.values()].sort((a, b) => a.index - b.index).map(finalizeCandidate);
  if (mergedCandidates.length > 0) result.candidates = mergedCandidates;

  return Object.keys(resultExtras).length > 0 ? ({ ...result, ...resultExtras } as GeminiResult) : result;
};
