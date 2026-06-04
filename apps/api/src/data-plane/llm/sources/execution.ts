import { listModelProviders, resolveModelForProvider } from '../../providers/registry.ts';
import { type ResponsesItemsCommit, storeResponsesOutputItems } from './responses/items/output.ts';
import {
  planResponsesItemProviders,
  prepareStoredResponsesItemsForSource,
  rewriteStoredResponsesItemsForProvider,
} from './responses/items/request-plan.ts';
import type { LlmEndpointPlan, LlmServeFailure, Result } from './traits.ts';

export const executeLlmSourcePlan = async <TItems, TEvent>(
  plan: LlmEndpointPlan<TItems, TEvent>,
  renderFailure: (failure: LlmServeFailure) => Result<TEvent>,
): Promise<{ result: Result<TEvent>; commitForNonStreaming?: ResponsesItemsCommit }> => {
  const statefulResponsesStore = plan.request.statefulResponsesStore;
  await statefulResponsesStore.loadInputItems({
    sourceItems: plan.items,
    view: plan.responsesItemsView,
    ...(plan.statefulResponsesInputItems !== undefined ? { inputItemsToStage: plan.statefulResponsesInputItems } : {}),
  });
  const prepared = await prepareStoredResponsesItemsForSource(plan.items, plan.responsesItemsView, statefulResponsesStore);
  if (prepared.failures[0]) return { result: renderFailure(prepared.failures[0]) };
  if (plan.statefulResponsesInputItems !== undefined) await statefulResponsesStore.stageInputItems(plan.statefulResponsesInputItems);
  await statefulResponsesStore.refreshTouchedItems();

  const providerPlan = planResponsesItemProviders(await listModelProviders(plan.request.apiKeyUpstreamIds), prepared);
  if (providerPlan.type === 'failure') return { result: renderFailure(providerPlan.failure) };

  let sawModel = false;
  for (const provider of providerPlan.providers) {
    const resolved = await resolveModelForProvider(provider, plan.model);
    if (!resolved) continue;
    sawModel = true;

    const { binding } = resolved;
    const target = plan.pickTarget(binding.upstreamModel.endpoints);
    if (!target) continue;

    statefulResponsesStore.beginAttempt(prepared.references);

    const rawResult = await plan.attempt({
      binding,
      target,
      model: resolved.id,
      rewriteItems: items => rewriteStoredResponsesItemsForProvider(items, prepared, binding, plan.responsesItemsView),
    });
    if (rawResult.type !== 'events') return { result: rawResult };

    const stored = storeResponsesOutputItems(rawResult.events, plan.responsesItemsView, {
      targetApi: target,
      upstream: binding.upstream,
      store: plan.store,
      snapshotMode: plan.responsesSnapshotMode ?? 'none',
    }, plan.request, plan.wantsStream);
    return { result: { ...rawResult, events: stored.events }, commitForNonStreaming: stored.commitForNonStreaming };
  }

  // The diagnostic names the model the client requested, not whichever upstream id a provider resolved it to.
  return { result: renderFailure(sawModel ? { kind: 'model-unsupported', model: plan.model } : { kind: 'model-missing', model: plan.model }) };
};
