import { fetchUpstreamModelsCached } from './models-cache.ts';
import { getRepo } from '../../repo/index.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { type ModelEndpointKey, type ModelEndpoints, kindForEndpoints } from '@floway-dev/protocols/common';
import type { InternalModel, ModelProviderInstance, ProviderModelRecord, ResolvedModel, Fetcher, UpstreamModel, UpstreamProviderKind, UpstreamRecord } from '@floway-dev/provider';
import { createAzureProvider } from '@floway-dev/provider-azure';
import { createCodexProvider } from '@floway-dev/provider-codex';
import { createCopilotProvider } from '@floway-dev/provider-copilot';
import { createCustomProvider } from '@floway-dev/provider-custom';
import { createOllamaProvider } from '@floway-dev/provider-ollama';

interface ProviderModelsResult {
  models: ResolvedModel[];
  sawSuccess: boolean;
  lastError: unknown;
  // Upstream names whose catalog fetch rejected this round, in the same
  // order as the input `providers` list so the model-missing renderer can
  // surface a stable, dashboard-aligned list.
  failedUpstreams: string[];
}

const NO_UPSTREAM_CONFIGURED_MESSAGE = 'No upstream provider configured — connect GitHub Copilot or add a Custom/Azure upstream in the dashboard';

type ProviderFactory = (record: UpstreamRecord) => ModelProviderInstance | Promise<ModelProviderInstance>;

const providerFactories: Record<UpstreamProviderKind, ProviderFactory> = {
  copilot: createCopilotProvider,
  custom: createCustomProvider,
  azure: createAzureProvider,
  codex: createCodexProvider,
  ollama: createOllamaProvider,
};

export const createProviderInstance = (record: UpstreamRecord): ModelProviderInstance | Promise<ModelProviderInstance> =>
  providerFactories[record.provider](record);

// The upstream scope is a required argument across the catalog-assembly chain
// (this, getModels, getInternalModels) so a caller can never omit it and
// silently receive the full, unscoped catalog — a missing scope is a compile
// error, not a runtime leak. Pass `null` to deliberately request every enabled
// upstream.
export const listModelProviders = async (
  upstreamFilter: readonly string[] | null,
): Promise<ModelProviderInstance[]> => {
  const upstreams = await getRepo().upstreams.list();
  const enabledById = new Map<string, UpstreamRecord>();
  const knownIds = new Set<string>();
  for (const upstream of upstreams) {
    knownIds.add(upstream.id);
    if (upstream.enabled) enabledById.set(upstream.id, upstream);
  }

  let selection: UpstreamRecord[];
  if (upstreamFilter) {
    // Unknown ids are a caller-side configuration error (the filter is the
    // intersection of per-user + per-api-key caps; both reference upstreams
    // by id); surface them so the operator notices instead of silently
    // serving a smaller subset. Disabled-but-known ids stay silent: a user
    // cap may legitimately mention an upstream the operator just disabled.
    const unknown = upstreamFilter.filter(id => !knownIds.has(id));
    if (unknown.length > 0) {
      throw new Error(`Unknown upstream id(s) in filter: ${unknown.join(', ')}`);
    }
    selection = upstreamFilter
      .map(id => enabledById.get(id))
      .filter((u): u is UpstreamRecord => u !== undefined);
  } else {
    selection = [...enabledById.values()];
  }

  const providers: ModelProviderInstance[] = [];
  for (const upstream of selection) {
    const factory = providerFactories[upstream.provider];
    providers.push(await factory(upstream));
  }

  return providers;
};

// Merge two capability maps: a key present in either side is present in the
// result, and its sub-capability flags are OR-ed so a sub-cap advertised by
// either provider survives.
const unionEndpoints = (a: ModelEndpoints, b: ModelEndpoints): ModelEndpoints => {
  const result: ModelEndpoints = { ...a };
  for (const key of Object.keys(b) as ModelEndpointKey[]) {
    const merged = { ...(result[key] ?? {}), ...b[key] };
    (result as Record<ModelEndpointKey, object>)[key] = merged;
  }
  return result;
};

const resolvedFromUpstreamModel = (upstreamModel: UpstreamModel, record: ProviderModelRecord): ResolvedModel => {
  const { providerData: _providerData, endpoints, ...internal } = upstreamModel;
  return {
    ...internal,
    endpoints: { ...endpoints },
    providers: [record],
  };
};

const collectProviderModels = async (
  providers: readonly ModelProviderInstance[],
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<ProviderModelsResult> => {
  const byId = new Map<string, ResolvedModel>();
  let sawSuccess = false;
  let lastError: unknown = null;
  const failedUpstreams: string[] = [];

  // Fan out per-upstream so a slow provider does not stall the rest. The SWR
  // cache layer dedupes concurrent in-flight fetches per upstream and serves
  // the SOFT-fresh row without an upstream round trip, so the parallel walk
  // is cheap on the warm path and bounded by `max(per-upstream fetch)` on
  // the cold path.
  const fetchOne = (instance: ModelProviderInstance) =>
    fetchUpstreamModelsCached(instance, {
      scheduler,
      fetcher: fetcherForUpstream(instance.upstream),
    }).then(models => ({ instance, models }));

  const settled = await Promise.allSettled(providers.map(fetchOne));

  for (const [index, result] of settled.entries()) {
    if (result.status === 'rejected') {
      // Caller-driven cancellation must propagate. Burying it in lastError
      // and letting an earlier sawSuccess return a partially-populated
      // model list would mask the abort and let the rest of the data-plane
      // request build a Response against a stale catalog.
      const error = result.reason;
      if (error instanceof Error && error.name === 'AbortError') throw error;
      lastError = error;
      failedUpstreams.push(providers[index].name);
      continue;
    }
    sawSuccess = true;
    const { instance, models: providedModels } = result.value;
    // Operator-disabled public model ids vanish entirely for this upstream:
    // dropped before they reach the catalog map, so they appear in no /models
    // listing and resolve to nothing for routing. The disable is per-upstream,
    // so the same id can still surface from another upstream that allows it.
    const disabled = new Set(instance.disabledPublicModelIds);
    for (const upstreamModel of providedModels) {
      if (!upstreamModel.id) continue;
      if (disabled.has(upstreamModel.id)) continue;
      const record = providerModelRecord(instance, upstreamModel);
      const existing = byId.get(upstreamModel.id);
      if (!existing) {
        byId.set(upstreamModel.id, resolvedFromUpstreamModel(upstreamModel, record));
        continue;
      }

      // When multiple providers expose the same public model id, the first
      // provider's metadata remains the public /models metadata. Runtime
      // execution still uses the selected provider's own UpstreamModel, so
      // capability-sensitive calls do not depend on this merged view being
      // perfectly representative.
      const endpoints = unionEndpoints(existing.endpoints, upstreamModel.endpoints);
      byId.set(upstreamModel.id, {
        ...existing,
        endpoints,
        kind: kindForEndpoints(endpoints),
        providers: [...existing.providers, record],
      });
    }
  }

  return { models: [...byId.values()], sawSuccess, lastError, failedUpstreams };
};

const modelWithProviderInstances = (model: ResolvedModel, providers: ReadonlySet<ModelProviderInstance>): ResolvedModel => {
  const providerInstances = [...providers];
  const bindings = model.providers.filter(binding => providerInstances.some(instance => instance.upstream === binding.upstream && instance.provider === binding.provider));
  const endpoints = bindings.reduce<ModelEndpoints>((acc, binding) => unionEndpoints(acc, binding.upstreamModel.endpoints), {});

  return {
    ...model,
    endpoints,
    kind: kindForEndpoints(endpoints),
    providers: bindings,
  };
};

// Public-facing model-id ordering, applied in getModels() to every list that
// crosses a gateway boundary (data-plane /v1/models, /models, /v1beta/models
// and the control-plane /api/models that backs the dashboard models page).
// Provider upstreams return models in arbitrary order; sorting here gives the
// dashboard and downstream clients a stable, family-grouped view.
//
// Sort keys, evaluated in order:
//   0. Whether the id contains a '/'. Slashed ids (Microsoft Foundry router
//      model ids like "accounts/msft/routers/x") are pushed to the tail so
//      the typical flat ids stay on top.
//   1. Leading [a-zA-Z]+ prefix, case-insensitive, ascending. Groups model
//      families: "claude-haiku-4-5" -> "claude", "deepseek-v4-pro" ->
//      "deepseek".
//   2. Array of isolated single digits (a digit surrounded on both sides by a
//      non-digit, with start/end of string counting as non-digit), compared
//      element by element as integers, DESCENDING — newer/larger versions
//      first: "claude-opus-4-7" -> [4, 7] beats "claude-opus-4-5" -> [4, 5];
//      "gpt-5.5" -> [5, 5] beats "gpt-4o" -> [4]. Multi-digit runs (dates,
//      "20300101") are intentionally not counted as version parts.
//   3. Full string lex order, DESCENDING, case-folded first then raw — keeps
//      "GPT-4o" and "gpt-4o" adjacent while giving longer/later suffixes
//      priority within an otherwise tied group.
export const compareModelIds = (a: string, b: string): number => {
  const cmp = <T>(x: T, y: T, dir = 1) => (x < y ? -dir : x > y ? dir : 0);
  const prefix = (s: string) => /^[a-zA-Z]+/.exec(s)?.[0].toLowerCase() ?? '';
  const digits = (s: string) => [...s.matchAll(/(?<!\d)\d(?!\d)/g)].map(m => +m[0]);
  const [da, db] = [digits(a), digits(b)];
  return cmp(+a.includes('/'), +b.includes('/'))
    || cmp(prefix(a), prefix(b))
    || (da.slice(0, Math.min(da.length, db.length)).map((v, i) => db[i] - v).find(d => d !== 0) ?? db.length - da.length)
    || cmp(a.toLowerCase(), b.toLowerCase(), -1)
    || cmp(a, b, -1);
};

// `fetcherForUpstream` routes each upstream's catalog fetch through its
// per-upstream proxy chain.
export const getModels = async (
  upstreamFilter: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<ResolvedModel[]> => {
  const providers = await listModelProviders(upstreamFilter);
  if (providers.length === 0) {
    throw new Error(NO_UPSTREAM_CONFIGURED_MESSAGE);
  }

  const { models, sawSuccess, lastError } = await collectProviderModels(providers, fetcherForUpstream, scheduler);

  if (sawSuccess) return [...models].sort((a, b) => compareModelIds(a.id, b.id));
  if (lastError) throw lastError;
  return [];
};

export const getInternalModels = async (
  upstreamFilter: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<InternalModel[]> =>
  (await getModels(upstreamFilter, fetcherForUpstream, scheduler)).map(({ providers: _providers, endpoints: _endpoints, ...model }) => model);

interface ModelResolution {
  id: string;
  model?: ResolvedModel;
  // Upstream names whose catalog fetch rejected during this resolution.
  // Threaded out so the caller's failure renderer can mention them
  // parenthetically — same data the dashboard's `modelsCache.lastError`
  // surfaces, but inlined into the per-request 404/400 so a client sees
  // why their model might be temporarily missing.
  failedUpstreams: readonly string[];
}

interface ProviderModelResolution {
  id: string;
  model: UpstreamModel;
  binding: ProviderModelRecord;
}

const resolveProviderAlias = (providers: readonly ModelProviderInstance[], byId: ReadonlyMap<string, ResolvedModel>, modelId: string): ResolvedModel | undefined => {
  let resolved: ResolvedModel | undefined;
  const providersForAlias = new Set<ModelProviderInstance>();

  for (const instance of providers) {
    const aliasTarget = instance.resolveRequestedModelId?.(modelId);
    if (!aliasTarget || aliasTarget === modelId) continue;

    const model = byId.get(aliasTarget);
    if (!model) continue;
    if (resolved && resolved.id !== model.id) continue;

    const providerHasModel = model.providers.some(binding => binding.upstream === instance.upstream && binding.provider === instance.provider);
    if (!providerHasModel) continue;

    resolved = model;
    providersForAlias.add(instance);
  }

  if (!resolved) return undefined;
  return modelWithProviderInstances(resolved, providersForAlias);
};

export const resolveModelForRequest = async (
  modelId: string,
  upstreamFilter: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<ModelResolution> => {
  const providers = await listModelProviders(upstreamFilter);
  if (providers.length === 0) {
    throw new Error(NO_UPSTREAM_CONFIGURED_MESSAGE);
  }

  const { models, failedUpstreams } = await collectProviderModels(providers, fetcherForUpstream, scheduler);
  const byId = new Map(models.map(model => [model.id, model]));

  const exact = byId.get(modelId);
  if (exact) return { id: exact.id, model: exact, failedUpstreams };

  const alias = resolveProviderAlias(providers, byId, modelId);
  if (alias) return { id: alias.id, model: alias, failedUpstreams };

  // Treat a failing upstream as "no models from that upstream right now"
  // rather than rethrowing its catalog error — other upstreams still
  // route, and the failed list is handed back so the caller's failure
  // body can name the affected upstreams.
  return { id: modelId, failedUpstreams };
};

const providerModelRecord = (instance: ModelProviderInstance, upstreamModel: UpstreamModel): ProviderModelRecord => ({
  upstream: instance.upstream,
  upstreamName: instance.name,
  providerKind: instance.providerKind,
  provider: instance.provider,
  upstreamModel,
  enabledFlags: upstreamModel.enabledFlags,
  supportsResponsesItemReference: instance.supportsResponsesItemReference,
});

export const resolveModelForProvider = async (
  instance: ModelProviderInstance,
  modelId: string,
  fetcher: Fetcher,
  scheduler: BackgroundScheduler,
): Promise<ProviderModelResolution | undefined> => {
  const providedModels = await fetchUpstreamModelsCached(instance, { scheduler, fetcher });
  const disabled = new Set(instance.disabledPublicModelIds);
  const exact = providedModels.find(model => model.id === modelId && !disabled.has(model.id));
  if (exact) return { id: exact.id, model: exact, binding: providerModelRecord(instance, exact) };

  const aliasTarget = instance.resolveRequestedModelId?.(modelId);
  if (!aliasTarget || aliasTarget === modelId) return undefined;

  const alias = providedModels.find(model => model.id === aliasTarget && !disabled.has(model.id));
  return alias ? { id: alias.id, model: alias, binding: providerModelRecord(instance, alias) } : undefined;
};
