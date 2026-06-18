import { createPerRequestFetcher } from '../../../dial/per-request.ts';
import { listModelProviders, resolveModelForProvider } from '../../providers/registry.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { LlmTargetApi, ProviderCandidate } from '@floway-dev/provider';

export type { ProviderCandidate };

// Returns the candidates that satisfy both the model resolution and the
// target-endpoint pick, plus a `sawModel` flag that distinguishes the
// "model is missing entirely" failure from "model exists but does not
// expose the endpoint this source needs".
export const enumerateProviderCandidates = async ({
  upstreamIds, model, pickTarget, scheduler, currentColo,
}: {
  // null = unrestricted; empty list = no providers visible.
  upstreamIds: readonly string[] | null;
  model: string;
  pickTarget: (endpoints: ModelEndpoints) => LlmTargetApi | null;
  // Threaded into `resolveModelForProvider` so the per-upstream catalog
  // lookup hits the SWR-cached `fetchUpstreamModelsCached` instead of
  // round-tripping to the upstream on every LLM serve.
  scheduler: BackgroundScheduler;
  // Current colo for this data-plane request — see GatewayCtx.currentColo.
  // Threaded into the per-request fetcher so colo-scoped fallback entries
  // can be honoured at dial time.
  currentColo: string | null;
}): Promise<{ readonly candidates: readonly ProviderCandidate[]; readonly sawModel: boolean }> => {
  const fetcherForUpstream = await createPerRequestFetcher(currentColo);
  const providers = await listModelProviders(upstreamIds);
  const candidates: ProviderCandidate[] = [];
  let sawModel = false;

  for (const provider of providers) {
    const fetcher = fetcherForUpstream(provider.upstream);
    const resolved = await resolveModelForProvider(provider, model, fetcher, scheduler);
    if (!resolved) continue;
    sawModel = true;

    const targetApi = pickTarget(resolved.binding.upstreamModel.endpoints);
    if (!targetApi) continue;

    candidates.push({ provider, binding: resolved.binding, targetApi, fetcher });
  }

  return { candidates, sawModel };
};
