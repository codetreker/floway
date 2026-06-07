// Sync `context_window` and `max_context_window` on codex catalog entries
// with floway's own registry. The codex bundled catalog speaks for the
// OpenAI 1p backend it ships with; floway routes these slugs to a
// different upstream (Copilot, custom, azure) whose real window comes
// from the registry, so the registry is the only source that knows what
// the gateway can actually serve.
//
// Both fields are written together so the codex client lifts every
// derived gate to the same window — `max_context_window` controls the
// outer ceiling and `context_window` the per-request limit, and codex
// only treats them as equivalent when they match.
//
// `auto_compact_token_limit` is left as the bundled `null`; codex resolves
// null to `(context_window * 9) / 10` (i64 integer arithmetic) at runtime
// in `ModelInfo::auto_compact_token_limit`, which for our 1000-aligned
// values equals `floor(context_window * 0.9)` — the trigger we want
// without inventing a magic literal. An explicit value is clamped to
// `min(explicit, (cw * 9) / 10)` by the same function, so writing the
// 90% number ourselves would be a no-op anyway. codex's own bundled
// catalog ships every entry with `null`.
//   https://github.com/openai/codex/blob/f221438b691b8f749d98f22077c93ebe01923fbe/codex-rs/protocol/src/openai_models.rs#L360-L375
//
// Slugs the resolver has no value for pass through unchanged.

import type { CodexCatalog } from './catalog.ts';

export type ContextWindowResolver = (slug: string) => number | null;

export const applyContextWindowFromRegistry = (catalog: CodexCatalog, contextWindowOf: ContextWindowResolver): CodexCatalog => ({
  models: catalog.models.map(model => {
    const actual = contextWindowOf(model.slug);
    if (actual === null) return model;
    return { ...model, context_window: actual, max_context_window: actual };
  }),
});
