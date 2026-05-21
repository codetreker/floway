import type { ModelCapabilities } from '../../providers/capabilities.ts';
import type { LlmTargetApi } from '../interceptors.ts';
import type { ExecuteResult } from '../shared/errors/result.ts';
import type { ProtocolFrame } from '../shared/stream/types.ts';

/**
 * Per-translation context. Carries everything a translator might read that is
 * not on the source payload itself. Concrete pair translators consume only the
 * fields they need; closures inside a Translation may also keep private
 * per-invocation state (for example, a synthetic response id per call).
 */
export interface TranslationBuildContext {
  readonly model: string;
  readonly wantsStream: boolean;
  readonly capabilities: ModelCapabilities;
}

/**
 * Pure cross-protocol translation. The source serve treats Translation as
 * opaque: it knows which target the planner selected (via `targetApi`), hands
 * in the source payload to receive a target payload, and maps the target's
 * protocol events back into the source's protocol events. The caller never
 * inspects translator internals.
 */
export interface Translation<SrcPayload, SrcEvent, TgtPayload extends { model: string }, TgtEvent> {
  readonly targetApi: LlmTargetApi;
  buildTargetPayload(src: SrcPayload, ctx: TranslationBuildContext): TgtPayload | Promise<TgtPayload>;
  translateEvents(events: AsyncIterable<ProtocolFrame<TgtEvent>>, ctx: TranslationBuildContext): AsyncIterable<ProtocolFrame<SrcEvent>>;
}

/**
 * Common signature for native and translated source emits. The source serve
 * holds a Record<LlmTargetApi, SourceEmit<...>> and dispatches without
 * branching on whether translation occurred.
 */
export type SourceEmit<SrcPayload, SrcEvent> = (
  srcPayload: SrcPayload,
  ctx: TranslationBuildContext,
) => Promise<ExecuteResult<ProtocolFrame<SrcEvent>>>;

/**
 * Factory: combines a Translation with a target-protocol emit into a
 * SourceEmit. Non-event results pass through unchanged so source error shaping
 * observes the original upstream/internal failure context.
 */
export const viaTranslation = <SrcPayload, SrcEvent, TgtPayload extends { model: string }, TgtEvent>(
  translation: Translation<SrcPayload, SrcEvent, TgtPayload, TgtEvent>,
  targetEmit: (tgtPayload: TgtPayload) => Promise<ExecuteResult<ProtocolFrame<TgtEvent>>>,
): SourceEmit<SrcPayload, SrcEvent> => async (srcPayload, ctx) => {
  const tgtPayload = await translation.buildTargetPayload(srcPayload, ctx);
  const tgtResult = await targetEmit(tgtPayload);
  if (tgtResult.type !== 'events') return tgtResult;
  return { ...tgtResult, events: translation.translateEvents(tgtResult.events, ctx) };
};
