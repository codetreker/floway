<script setup lang="ts">
// Top-level upstream editor page. Owns the entire draft state (provider,
// name, enabled, flag overrides, disabled model ids, plus the
// provider-specific custom/azure drafts) and the live /models fetch for
// custom upstreams. Renders the two-column workbench: UpstreamConfigPanel on
// the left, ModelsPanel on the right.

import { Button } from '@floway-dev/ui';
import type { InferRequestType } from 'hono/client';
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';

import { callApi, useApi } from '../../api/client.ts';
import type { AzureUpstreamConfig, CopilotQuotaSnapshot, CustomRawModel, CustomUpstreamConfig, FlagDef, ModelEndpoints, UpstreamModelConfig, UpstreamProviderKind, UpstreamRecord } from '../../api/types.ts';

import {
  type AzureDraft,
  blankAzureDraft,
  blankCustomDraft,
  buildCustomConfigCore,
  type CustomDraft,
  seedPathOverrides,
} from './customConfig.ts';
import ModelsPanel from './ModelsPanel.vue';
import UpstreamConfigPanel from './UpstreamConfigPanel.vue';

const props = defineProps<{
  mode: 'create' | 'edit';
  record: UpstreamRecord | null;
  // Default provider for create mode; ignored in edit mode (taken from record).
  initialProvider?: UpstreamProviderKind;
  nextSortOrder: number;
  flags: FlagDef[];
  // Provider-specific model lists pre-fetched by the route loader so the
  // editor mounts with its right pane already populated. Empty arrays mean
  // "nothing to show" (wrong provider, fetch disabled, or fetch failed —
  // see the matching error fields).
  initialCopilotModels?: UpstreamModelConfig[];
  initialCopilotModelsError?: string | null;
  initialCopilotQuota?: CopilotQuotaSnapshot | null;
  initialCopilotQuotaError?: string | null;
  initialCustomRawModels?: CustomRawModel[];
  initialCustomRawModelsError?: string | null;
  initialCustomFetchedAt?: number | null;
}>();

const emit = defineEmits<{
  saved: [record: UpstreamRecord | null];
}>();

const router = useRouter();
const api = useApi();

type CreateBody = InferRequestType<typeof api.api.upstreams.$post>['json'];
type PatchBody = InferRequestType<(typeof api.api.upstreams)[':id']['$patch']>['json'];

const activeProvider = ref<UpstreamProviderKind>(props.record?.provider ?? props.initialProvider ?? 'custom');
const name = ref('');
const enabled = ref(true);
const sortOrder = ref<number>(props.nextSortOrder);
const flagOverrides = ref<Record<string, boolean>>({});
const disabledPublicModelIds = ref<string[]>([]);
const customDraft = ref<CustomDraft>(blankCustomDraft());
const azureDraft = ref<AzureDraft>(blankAzureDraft());

const copilotModels = ref<UpstreamModelConfig[]>(props.initialCopilotModels ?? []);
const copilotModelsError = ref<string | null>(props.initialCopilotModelsError ?? null);

const defaultName = (p: UpstreamProviderKind) =>
  p === 'azure' ? 'Azure AI' : p === 'copilot' ? 'GitHub Copilot' : 'Custom upstream';

const seedFromRecord = (r: UpstreamRecord) => {
  activeProvider.value = r.provider;
  name.value = r.name;
  enabled.value = r.enabled;
  sortOrder.value = r.sort_order;
  flagOverrides.value = { ...r.flag_overrides };
  disabledPublicModelIds.value = [...r.disabled_public_model_ids];

  if (r.provider === 'custom') {
    const cfg = r.config as CustomUpstreamConfig;
    customDraft.value = {
      baseUrl: cfg.baseUrl ?? '',
      authStyle: cfg.authStyle ?? 'bearer',
      endpoints: { ...(cfg.endpoints ?? {}) },
      bearerToken: '',
      pathOverrides: seedPathOverrides(cfg.pathOverrides),
      modelsFetch: cfg.modelsFetch
        ? { enabled: cfg.modelsFetch.enabled, endpoint: cfg.modelsFetch.endpoint ?? '' }
        : { enabled: true, endpoint: '' },
      // r.config is reactive (props passthrough); structuredClone refuses Vue
      // Proxies in Chromium and toRaw only unwraps the top layer. The models
      // tree is plain data, so a JSON round-trip is the cheapest way to land a
      // deep, proxy-free copy that the field can mutate freely.
      models: cfg.models ? (JSON.parse(JSON.stringify(cfg.models)) as UpstreamModelConfig[]) : [],
    };
  } else if (r.provider === 'azure') {
    const cfg = r.config as AzureUpstreamConfig;
    azureDraft.value = {
      endpoint: cfg.endpoint ?? '',
      apiKey: '',
      models: cfg.models ? (JSON.parse(JSON.stringify(cfg.models)) as UpstreamModelConfig[]) : [],
    };
  }
};

const seedFresh = () => {
  name.value = defaultName(activeProvider.value);
  enabled.value = true;
  sortOrder.value = props.nextSortOrder;
  flagOverrides.value = {};
  disabledPublicModelIds.value = [];
  customDraft.value = blankCustomDraft();
  azureDraft.value = blankAzureDraft();
};

if (props.mode === 'edit' && props.record) seedFromRecord(props.record);
else seedFresh();

// In create mode, switching providers also rewrites the name field when it
// still matches the previous provider's default (i.e. it has not been
// customized).
const setActiveProvider = (next: UpstreamProviderKind) => {
  if (activeProvider.value === next) return;
  const prevDefault = defaultName(activeProvider.value);
  if (props.mode === 'create' && name.value === prevDefault) name.value = defaultName(next);
  activeProvider.value = next;
};

const customBearerTokenSet = computed(() => {
  const cfg = props.record?.config as CustomUpstreamConfig | undefined;
  return cfg?.bearerTokenSet === true;
});
const azureApiKeySet = computed(() => {
  const cfg = props.record?.config as AzureUpstreamConfig | undefined;
  return cfg?.apiKeySet === true;
});

const fetchedRaw = ref<CustomRawModel[]>(props.initialCustomRawModels ?? []);
const fetchLoading = ref(false);
const fetchError = ref<string | null>(props.initialCustomRawModelsError ?? null);
const fetchedAtMs = ref<number | null>(props.initialCustomFetchedAt ?? null);

// A custom raw model carries no per-endpoint hint beyond its kind. Embedding
// and image map to their fixed endpoints; chat models follow the
// upstream-level Default LLM Endpoints selection, mirroring how the data
// plane derives an auto chat model's endpoints from the per-upstream config.
const endpointsForKind = (kind: CustomRawModel['kind']): ModelEndpoints => {
  if (kind === 'embedding') return { embeddings: {} };
  if (kind === 'image') return { imagesGenerations: {}, imagesEdits: {} };
  return Object.keys(customDraft.value.endpoints).length > 0
    ? { ...customDraft.value.endpoints }
    : { chatCompletions: {} };
};

const customAutoModels = computed<UpstreamModelConfig[]>(() => fetchedRaw.value.map(m => {
  const label = m.display_name ?? m.name;
  return {
    upstreamModelId: m.id,
    publicModelId: m.id,
    kind: m.kind ?? 'chat',
    endpoints: endpointsForKind(m.kind),
    ...(label ? { display_name: label } : {}),
    ...(m.limits ? { limits: m.limits } : {}),
    ...(m.cost ? { cost: m.cost } : {}),
  };
}));

const fetchModels = async () => {
  if (activeProvider.value !== 'custom') return;
  fetchLoading.value = true;
  fetchError.value = null;
  try {
    const { data, error } = await callApi<{ data: CustomRawModel[] }>(
      () => api.api.upstreams['fetch-models'].$post({
        json: { id: props.record?.id, config: { ...buildCustomConfigCore(customDraft.value), models: customDraft.value.models } },
      }),
    );
    // The toggle may have been turned off while this request was in flight;
    // with fetch disabled the auto block is hidden and dropped on save, so
    // discard the late result rather than repopulating stale auto rows.
    if (!customDraft.value.modelsFetch.enabled) return;
    if (error) { fetchError.value = error.message; return; }
    fetchedRaw.value = data?.data ?? [];
    fetchedAtMs.value = Date.now();
  } finally {
    fetchLoading.value = false;
  }
};

watch(() => customDraft.value.modelsFetch.enabled, on => {
  if (!on) {
    fetchedRaw.value = [];
    fetchError.value = null;
    fetchedAtMs.value = null;
  }
});

const fetchStatus = computed<string | null>(() => {
  if (fetchLoading.value) return 'fetching…';
  if (fetchedAtMs.value === null) return null;
  const ago = Math.max(0, Date.now() - fetchedAtMs.value);
  const mins = Math.floor(ago / 60000);
  const label = mins < 1 ? 'just now' : `${mins}m ago`;
  return `${fetchedRaw.value.length} returned · ${label}`;
});

const saving = ref(false);
const saveError = ref<string | null>(null);

const buildCustomConfig = (): Extract<CreateBody, { provider: 'custom' }>['config'] => {
  const config: Extract<CreateBody, { provider: 'custom' }>['config'] = {
    ...buildCustomConfigCore(customDraft.value),
    models: customDraft.value.models,
  };
  const overrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(customDraft.value.pathOverrides)) {
    const trimmed = v.trim();
    if (trimmed) overrides[k] = trimmed;
  }
  if (Object.keys(overrides).length > 0) config.pathOverrides = overrides;
  else if (props.mode === 'edit') config.pathOverrides = null;
  return config;
};

const buildAzureConfig = (): Extract<CreateBody, { provider: 'azure' }>['config'] => {
  const config: Extract<CreateBody, { provider: 'azure' }>['config'] = {
    endpoint: azureDraft.value.endpoint.trim(),
    models: azureDraft.value.models,
  };
  if (azureDraft.value.apiKey.trim()) config.apiKey = azureDraft.value.apiKey.trim();
  return config;
};

const baseFields = () => ({
  name: name.value.trim(),
  enabled: enabled.value,
  sort_order: sortOrder.value,
  flag_overrides: flagOverrides.value,
  disabled_public_model_ids: disabledPublicModelIds.value,
});

const save = async () => {
  saveError.value = null;
  const trimmedName = name.value.trim();
  if (!trimmedName) { saveError.value = 'Name is required'; return; }

  saving.value = true;
  try {
    if (props.mode === 'create') {
      let body: CreateBody;
      if (activeProvider.value === 'custom') {
        body = { provider: 'custom', ...baseFields(), config: buildCustomConfig() };
      } else if (activeProvider.value === 'azure') {
        body = { provider: 'azure', ...baseFields(), config: buildAzureConfig() };
      } else {
        // Copilot upstreams are born from the device flow on the panel — we
        // never POST here. The Save button is hidden in that mode.
        saveError.value = 'Copilot upstreams are created through the GitHub device flow.';
        return;
      }
      const { data, error } = await callApi<UpstreamRecord>(() => api.api.upstreams.$post({ json: body }));
      if (error) { saveError.value = error.message; return; }
      emit('saved', data ?? null);
    } else if (props.record) {
      const patch: PatchBody = baseFields();
      if (activeProvider.value === 'custom') patch.config = buildCustomConfig();
      else if (activeProvider.value === 'azure') patch.config = buildAzureConfig();
      const { error } = await callApi(
        () => api.api.upstreams[':id'].$patch({ param: { id: props.record!.id }, json: patch }),
      );
      if (error) { saveError.value = error.message; return; }
      emit('saved', props.record);
    }
    await router.push('/dashboard/settings');
  } finally {
    saving.value = false;
  }
};

const cancel = async () => {
  await router.push('/dashboard/settings');
};

const onCopilotCompleted = async (newRecord: UpstreamRecord | undefined) => {
  emit('saved', newRecord ?? null);
  if (newRecord) await router.replace(`/dashboard/upstreams/${newRecord.id}`);
};

// Copilot's catalog is read-only — `ModelsPanel` runs in `read-only` mode
// for that provider, so the v-model setter is never invoked. The getter
// just hands back an empty list to keep the type contract honest.
const modelsManualForActive = computed<UpstreamModelConfig[]>({
  get: () => {
    if (activeProvider.value === 'custom') return customDraft.value.models;
    if (activeProvider.value === 'azure') return azureDraft.value.models;
    return [];
  },
  set: next => {
    if (activeProvider.value === 'custom') customDraft.value = { ...customDraft.value, models: next };
    else if (activeProvider.value === 'azure') azureDraft.value = { ...azureDraft.value, models: next };
  },
});

const autoForActive = computed<UpstreamModelConfig[]>(() => {
  if (activeProvider.value === 'custom') return customDraft.value.modelsFetch.enabled ? customAutoModels.value : [];
  if (activeProvider.value === 'copilot') return copilotModels.value;
  return [];
});

const upstreamIdLabelForActive = computed(() => activeProvider.value === 'azure' ? 'Deployment' : 'Upstream Model ID');
const showSaveButton = computed(() => props.mode === 'edit' || activeProvider.value !== 'copilot');

// Public-id catalogue feeding the disabled-models combobox: every model
// currently surfaced for this provider, deduped by public id. A model's
// public id is its publicModelId override when set, otherwise its
// upstreamModelId — same rule the data plane filters by.
const availableModelItems = computed<{ value: string; label: string }[]>(() => {
  const seen = new Set<string>();
  const items: { value: string; label: string }[] = [];
  const collect = (list: UpstreamModelConfig[]) => {
    for (const m of list) {
      const id = m.publicModelId?.trim() || m.upstreamModelId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      items.push({ value: id, label: id });
    }
  };
  if (activeProvider.value === 'custom') {
    collect(customDraft.value.models);
    if (customDraft.value.modelsFetch.enabled) collect(customAutoModels.value);
  } else if (activeProvider.value === 'azure') {
    collect(azureDraft.value.models);
  } else if (activeProvider.value === 'copilot') {
    collect(copilotModels.value);
  }
  return items;
});

// Sum the right pane's children — the Models card + the Model Editor card,
// each at its own intrinsic height. We deliberately do NOT measure the
// ModelsPanel root itself, because the grid stretches it to row height (the
// taller of the two columns), which would feed itself back into the aside's
// max-h and lock the value high forever — selecting a smaller model would
// never let it shrink. The children of the panel are NOT stretched, so their
// summed height is the true intrinsic content height regardless of grid
// stretch.
const modelsPanelRef = useTemplateRef<{ $el: HTMLElement } | null>('modelsPanelRef');
const rightContentH = ref(0);
let rightObserver: ResizeObserver | undefined;
const measureRight = () => {
  const root = modelsPanelRef.value?.$el;
  if (!root) return;
  const kids = Array.from(root.children) as HTMLElement[];
  let h = 0;
  for (const k of kids) h += k.getBoundingClientRect().height;
  const gap = parseFloat(getComputedStyle(root).rowGap || '0') || 0;
  if (kids.length > 1) h += gap * (kids.length - 1);
  rightContentH.value = h;
};
watch(() => modelsPanelRef.value?.$el, root => {
  rightObserver?.disconnect();
  if (!root) return;
  rightObserver = new ResizeObserver(measureRight);
  for (const k of Array.from(root.children) as HTMLElement[]) rightObserver.observe(k);
  measureRight();
}, { immediate: true, flush: 'post' });
onBeforeUnmount(() => rightObserver?.disconnect());
const workbenchStyle = computed(() => ({ '--right-pane-h': `${Math.ceil(rightContentH.value)}px` }));
</script>

<template>
  <div>
    <header class="mb-5 flex flex-wrap items-center gap-3">
      <nav class="flex items-center gap-2 text-sm text-gray-500">
        <RouterLink to="/dashboard/settings" class="hover:text-gray-300">Settings</RouterLink>
        <span class="text-white/15">/</span>
        <RouterLink to="/dashboard/settings" class="hover:text-gray-300">Upstreams</RouterLink>
        <span class="text-white/15">/</span>
        <span class="font-semibold text-white">{{ mode === 'create' ? 'New upstream' : (record?.name ?? 'Upstream') }}</span>
      </nav>
      <div class="ml-auto flex items-center gap-2">
        <Button variant="secondary" :disabled="saving" @click="cancel">Cancel</Button>
        <Button v-if="showSaveButton" :loading="saving" @click="save">Save changes</Button>
      </div>
    </header>

    <p v-if="saveError" class="mb-4 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">{{ saveError }}</p>
    <p v-if="copilotModelsError" class="mb-4 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">Failed to fetch Copilot model list: {{ copilotModelsError }}</p>

    <!-- Two-column workbench. Default grid stretch makes both columns reach
         the same y at the row's bottom. The aside's max-h is the larger of
         (viewport-bound, right-pane's intrinsic content height) — so a
         long flag list scrolls inside the rail when the right pane is
         shorter than the viewport, and grows with the right pane when the
         editor is taller. The right intrinsic height comes from summing
         ModelsPanel's children (see measureRight) rather than the root
         element, which is itself stretched by the grid. -->
    <div :style="workbenchStyle" class="grid grid-cols-1 gap-5 lg:grid-cols-[400px_minmax(0,1fr)]">
      <UpstreamConfigPanel
        :provider="activeProvider"
        v-model:name="name"
        v-model:enabled="enabled"
        v-model:flag-overrides="flagOverrides"
        v-model:disabled-ids="disabledPublicModelIds"
        v-model:custom="customDraft"
        v-model:azure="azureDraft"
        :mode="mode"
        :record="record"
        :flags="flags"
        :custom-bearer-token-set="customBearerTokenSet"
        :azure-api-key-set="azureApiKeySet"
        :fetch-loading="fetchLoading"
        :fetch-error="fetchError"
        :fetch-status="fetchStatus"
        :available-model-items="availableModelItems"
        :initial-copilot-quota="initialCopilotQuota"
        :initial-copilot-quota-error="initialCopilotQuotaError"
        class="lg:max-h-[max(calc(100vh-7rem),var(--right-pane-h,0px))]"
        @update:provider="setActiveProvider"
        @fetch-models="fetchModels"
        @copilot-completed="onCopilotCompleted"
      />
      <ModelsPanel
        ref="modelsPanelRef"
        v-model="modelsManualForActive"
        v-model:disabled-ids="disabledPublicModelIds"
        :auto-models="autoForActive"
        :flags="flags"
        :upstream-flag-overrides="flagOverrides"
        :flag-provider-kind="activeProvider"
        :upstream-id-label="upstreamIdLabelForActive"
        :read-only="activeProvider === 'copilot'"
        :all-manual="activeProvider === 'azure'"
      />
    </div>
  </div>
</template>
