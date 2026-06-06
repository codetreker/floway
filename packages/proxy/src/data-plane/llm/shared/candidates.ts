import { listModelProviders, resolveModelForProvider } from '../../providers/registry.ts';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { LlmTargetApi, ProviderCandidate } from '@floway-dev/provider';

export type { ProviderCandidate };

// Returns the candidates that satisfy both the model resolution and the
// target-endpoint pick, plus a `sawModel` flag that distinguishes "model is
// missing entirely" (false → `model-missing` 404) from "model exists but
// doesn't expose the endpoint this source needs" (true → `model-unsupported`
// 400).
export const enumerateProviderCandidates = async ({
  apiKeyUpstreamIds, model, pickTarget,
}: {
  apiKeyUpstreamIds: readonly string[] | null;
  model: string;
  pickTarget: (endpoints: ModelEndpoints) => LlmTargetApi | null;
}): Promise<{ readonly candidates: readonly ProviderCandidate[]; readonly sawModel: boolean }> => {
  const providers = await listModelProviders(apiKeyUpstreamIds);
  const candidates: ProviderCandidate[] = [];
  let sawModel = false;

  for (const provider of providers) {
    const resolved = await resolveModelForProvider(provider, model);
    if (!resolved) continue;
    sawModel = true;

    const targetApi = pickTarget(resolved.binding.upstreamModel.endpoints);
    if (!targetApi) continue;

    candidates.push({ provider, binding: resolved.binding, targetApi });
  }

  return { candidates, sawModel };
};
