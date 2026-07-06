import type { GeminiCandidate, GeminiResult, GeminiPart, GeminiStreamEvent } from './index.ts';
import { captureExtras } from '../common/reassemble-extras.ts';

// Field-fidelity contract — see {@link captureExtras}. We accumulate the
// fields we understand on typed paths (parts, role, finishReason on
// candidates; modelVersion / responseId / usageMetadata on the top-level
// result); the key sets here name those known fields so anything else an
// upstream emits — `safetyRatings`, `groundingMetadata`, `citationMetadata`,
// future Gemini extensions, etc. — survives onto the assembled result.
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

export async function reassembleGeminiEvents(events: AsyncIterable<GeminiStreamEvent>): Promise<GeminiResult> {
  const candidates = new Map<number, GeminiCandidateWithExtras>();
  const result: GeminiResult = {};
  const resultExtras: Record<string, unknown> = {};

  for await (const event of events) {
    if ('error' in event) {
      throw new Error(`${event.error.status}: ${event.error.message}`, { cause: event });
    }

    for (const candidate of event.candidates ?? []) {
      mergeCandidate(candidates, candidate);
    }

    if (event.modelVersion !== undefined) result.modelVersion = event.modelVersion;
    if (event.responseId !== undefined) result.responseId = event.responseId;
    if (event.usageMetadata !== undefined) result.usageMetadata = event.usageMetadata;
    captureExtras(event as unknown as Record<string, unknown>, KNOWN_RESULT_KEYS, resultExtras);
  }

  const mergedCandidates = [...candidates.values()].sort((a, b) => a.index - b.index).map(finalizeCandidate);
  if (mergedCandidates.length > 0) result.candidates = mergedCandidates;

  return Object.keys(resultExtras).length > 0 ? ({ ...result, ...resultExtras } as GeminiResult) : result;
}
