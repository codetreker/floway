import { describe, expect, it } from 'vitest';

import type { CodexCatalog } from './catalog.ts';
import { applyContextWindowFromRegistry } from './context-window.ts';

describe('applyContextWindowFromRegistry', () => {
  const buildCatalog = (): CodexCatalog => ({
    models: [
      { slug: 'gpt-5.5', context_window: 272000, max_context_window: 272000, base_instructions: 'unchanged' },
      { slug: 'gpt-5.4', context_window: 272000, max_context_window: 1000000, base_instructions: 'unchanged-too' },
      { slug: 'gpt-5.3-codex', context_window: 272000, max_context_window: 272000 },
    ],
  });

  it('writes both context_window and max_context_window from the registry value', () => {
    const out = applyContextWindowFromRegistry(buildCatalog(), slug => (slug === 'gpt-5.5' ? 1050000 : null));
    expect(out.models.find(m => m.slug === 'gpt-5.5')).toEqual({
      slug: 'gpt-5.5',
      context_window: 1050000,
      max_context_window: 1050000,
      base_instructions: 'unchanged',
    });
  });

  it('downgrades fields when the registry advertises less than the bundled max', () => {
    // Bundled gpt-5.4 has max_context_window=1000000 but registry tells us
    // the gateway can only serve 272000. We trust the registry — codex must
    // not believe a window we cannot honour.
    const out = applyContextWindowFromRegistry(buildCatalog(), slug => (slug === 'gpt-5.4' ? 272000 : null));
    expect(out.models.find(m => m.slug === 'gpt-5.4')).toEqual({
      slug: 'gpt-5.4',
      context_window: 272000,
      max_context_window: 272000,
      base_instructions: 'unchanged-too',
    });
  });

  it('passes a slug through unchanged when the resolver has no value for it', () => {
    const out = applyContextWindowFromRegistry(buildCatalog(), () => null);
    expect(out.models).toEqual(buildCatalog().models);
  });

  it('does not mutate the input catalog', () => {
    const input = buildCatalog();
    const snapshot = JSON.parse(JSON.stringify(input)) as CodexCatalog;
    applyContextWindowFromRegistry(input, () => 1050000);
    expect(input).toEqual(snapshot);
  });
});
