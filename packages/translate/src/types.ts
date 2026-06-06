import type { ProtocolFrame } from '@floway-dev/protocols/common';

/**
 * Per-trip context. Carries the model name plus a per-pair-declared `TCaps`
 * shape that lists exactly the capability fields the trip reads. Pairs that
 * need no extra capability fields pass an empty object type. Callers
 * (typically source serves) construct one wide context whose shape is the
 * union of every pair's TCaps and reuse it across the dispatch map.
 *
 * The client's stream preference is intentionally not in this context.
 * Translation always emits `stream: true` on the target payload; the LLM
 * upstream layer enforces SSE streaming and source `respond.ts` boundaries
 * collect a non-streamed downstream response when the client did not ask
 * for SSE.
 */
export type TranslationContext<TCaps = unknown> = {
  readonly model: string;
} & TCaps;

/**
 * One pairwise translation trip. The function body owns the trip: it builds
 * the target payload and returns an events translator closure that maps
 * target-protocol events back into source-protocol events. Trip-scoped state
 * (synthetic ids, custom-tool name sets, etc.) lives as locals captured by
 * the returned closure — the source serve never sees them.
 *
 * Stateless pairs simply return a function reference for `events`. Stateful
 * pairs let the closure capture whatever locals the trip needs.
 *
 * `TCaps` is the pair-declared capability surface: each pair lists exactly
 * the fields it reads from `TranslationContext`. Pairs that do not need any
 * upstream capability data leave it as `unknown` (default).
 */
export type TranslateTrip<SrcPayload, SrcEvent, TgtPayload extends { model: string }, TgtEvent, TCaps = unknown> = (
  src: SrcPayload,
  ctx: TranslationContext<TCaps>,
) => Promise<{
  target: TgtPayload;
  events: (frames: AsyncIterable<ProtocolFrame<TgtEvent>>) => AsyncIterable<ProtocolFrame<SrcEvent>>;
}>;
