import { copilotRawModelId } from './model-name.ts';
import type { CopilotModelsResponse, CopilotRawModel } from './types.ts';

export const CONTEXT_1M_BETA = 'context-1m-2025-08-07';

const CLAUDE_DATE_SUFFIX = /-\d{8}$/;
const STANDARD_CLAUDE_BASE_ID = /^claude-[a-z0-9-]+-\d+(?:\.\d+)?$/;
const KNOWN_CLAUDE_VARIANT_SUFFIXES = new Set(['high', 'xhigh', '1m', '1m-internal']);

export interface ModelSelectionHints {
  context1m?: boolean;
  reasoningEffort?: string;
}

const stripClaudeDateSuffix = (id: string): string => (id.startsWith('claude-') ? id.replace(CLAUDE_DATE_SUFFIX, '') : id);

const normalizedClaudeLookupId = (id: string): string => copilotRawModelId(stripClaudeDateSuffix(id));

export const hasContext1mBeta = (anthropicBeta: readonly string[] | undefined): boolean => anthropicBeta?.includes(CONTEXT_1M_BETA) === true;

const standardClaudeBaseId = (id: string): string | undefined => {
  if (!id.startsWith('claude-')) return undefined;
  return STANDARD_CLAUDE_BASE_ID.test(id) ? id : undefined;
};

const claudeVariantSuffix = (baseId: string, id: string): string | undefined => (id === baseId ? '' : id.startsWith(`${baseId}-`) ? id.slice(baseId.length + 1) : undefined);

const isClaudeVariantForBase = (baseId: string, model: CopilotRawModel): boolean => {
  const suffix = claudeVariantSuffix(baseId, model.id);
  return suffix === '' || (suffix !== undefined && KNOWN_CLAUDE_VARIANT_SUFFIXES.has(suffix));
};

const supportsOneMillionContext = (model: CopilotRawModel): boolean => {
  // Trust id-level intent first: Copilot has been observed to report
  // claude-opus-4.7-1m-internal with max_context_window_tokens=200000 even
  // though the variant exists specifically for the 1M-context surface. The
  // explicit-number check used to short-circuit and hide that signal.
  if (/-1m(?:-|$)/.test(model.id)) return true;

  const limits = model.capabilities?.limits;
  const explicit = limits?.max_context_window_tokens;
  if (typeof explicit === 'number') return explicit >= 1_000_000;

  const prompt = limits?.max_prompt_tokens ?? 0;
  const output = limits?.max_output_tokens ?? 0;
  return prompt + output >= 1_000_000;
};

const supportsReasoningEffort = (model: CopilotRawModel, effort: string | undefined): boolean => {
  if (!effort) return true;
  return model.capabilities?.supports?.reasoning_effort?.includes(effort) === true;
};

const byModelPreference = (a: CopilotRawModel, b: CopilotRawModel): number => {
  const aBase = a.id.split('-').length;
  const bBase = b.id.split('-').length;
  return aBase - bBase || a.id.localeCompare(b.id);
};

const firstPreferred = (models: readonly CopilotRawModel[]): CopilotRawModel | undefined => [...models].sort(byModelPreference)[0];

const chooseClaudeVariant = (candidates: readonly CopilotRawModel[], exactBase: CopilotRawModel | undefined, hints: ModelSelectionHints): CopilotRawModel | undefined => {
  const effort = hints.reasoningEffort;
  if (!hints.context1m && !effort) {
    return exactBase ?? firstPreferred(candidates);
  }

  if (hints.context1m) {
    const oneMillion = candidates.filter(supportsOneMillionContext);
    const oneMillionWithEffort = oneMillion.filter(model => supportsReasoningEffort(model, effort));
    return firstPreferred(oneMillionWithEffort) ?? firstPreferred(oneMillion) ?? exactBase ?? firstPreferred(candidates);
  }

  const withEffort = candidates.filter(model => supportsReasoningEffort(model, effort));
  return firstPreferred(withEffort.filter(supportsOneMillionContext)) ?? firstPreferred(withEffort) ?? exactBase ?? firstPreferred(candidates);
};

export const resolveCopilotRawModel = (models: CopilotModelsResponse, modelId: string, hints: ModelSelectionHints = {}): CopilotRawModel | undefined => {
  const normalized = normalizedClaudeLookupId(modelId);
  const exact = models.data.find(model => model.id === normalized);
  const exactBase = exact && STANDARD_CLAUDE_BASE_ID.test(exact.id) ? exact : undefined;

  if (exact && !exactBase) return exact;

  const baseId = standardClaudeBaseId(normalized);
  if (!baseId) return exact;

  const candidates = models.data.filter(model => isClaudeVariantForBase(baseId, model));
  if (candidates.length === 0) return exact;

  return chooseClaudeVariant(candidates, exactBase, hints);
};
