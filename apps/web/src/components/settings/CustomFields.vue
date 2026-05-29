<script setup lang="ts">
import { Button, Input, Switch } from '@floway-dev/ui';
import { computed, onMounted, ref, watch } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { CustomEndpoint, CustomRawModel, FlagDef, UpstreamModelConfig } from '../../api/types.ts';

import SecretInput from '../shared/SecretInput.vue';

import Accordion from './Accordion.vue';
import { buildCustomConfigCore, type CustomDraft } from './customConfig.ts';
import ModelListField from './ModelListField.vue';

// pathOverrides are keyed by the endpoint family ('chat_completions',
// 'responses', 'messages', 'embeddings'), each holding either an override URL
// or '' for "no override". We carry empty strings through here so the
// controlled inputs work; the parent dialog strips them at save time. The
// /models path lives in modelsFetch.endpoint, not here.
type PathKey = 'chat_completions' | 'responses' | 'messages' | 'embeddings' | 'images_generations' | 'images_edits';

const draft = defineModel<CustomDraft>({ required: true });

const props = defineProps<{
  bearerTokenSet: boolean;
  editMode: boolean;
  editId?: string;
  flags: FlagDef[];
  upstreamFlagOverrides: Record<string, boolean>;
}>();

const api = useApi();

const endpointPills: { value: CustomEndpoint; label: string }[] = [
  { value: '/chat/completions', label: '/chat/completions' },
  { value: '/responses', label: '/responses' },
  { value: '/v1/messages', label: '/messages' },
];

const pathOverrideKeys: PathKey[] = ['chat_completions', 'responses', 'messages', 'embeddings', 'images_generations', 'images_edits'];

const toggleEndpoint = (ep: CustomEndpoint) => {
  const set = new Set(draft.value.supportedEndpoints);
  if (set.has(ep)) set.delete(ep); else set.add(ep);
  draft.value = { ...draft.value, supportedEndpoints: Array.from(set) };
};

const updatePathOverride = (key: PathKey, value: string) => {
  draft.value = { ...draft.value, pathOverrides: { ...draft.value.pathOverrides, [key]: value } };
};

const overrideCount = computed(() => Object.values(draft.value.pathOverrides).filter(v => v.trim().length > 0).length);

const pathOverridesOpen = ref(false);

const bearerLabel = computed(() => {
  const anthropic = draft.value.authStyle === 'anthropic';
  if (props.editMode) return anthropic ? 'API Key (leave blank to keep)' : 'Bearer Token (leave blank to keep)';
  return anthropic ? 'API Key' : 'Bearer Token';
});

const bearerPlaceholder = computed(() => {
  if (props.bearerTokenSet) return '••••••••';
  return draft.value.authStyle === 'anthropic' ? 'sk-ant-xxxxx' : 'sk-xxxxx';
});

/* ====================== live /models browse ====================== */

// The raw /models result is kept as-is; the displayed auto rows are derived
// reactively below so a chat model's endpoints track the top-level selection
// live, not just at fetch time.
const fetchedRaw = ref<CustomRawModel[]>([]);
const fetchLoading = ref(false);
const fetchError = ref<string | null>(null);

// A custom raw model carries no per-endpoint hint beyond its kind. Embedding and
// image map to their fixed endpoints; chat models follow the upstream-level
// Default LLM Endpoints selection, mirroring how the data plane derives an
// auto chat model's endpoints from the per-upstream config.
const endpointsForKind = (kind: CustomRawModel['kind']): string[] => {
  if (kind === 'embedding') return ['/embeddings'];
  if (kind === 'image') return ['/v1/images/generations', '/v1/images/edits'];
  return draft.value.supportedEndpoints.length ? [...draft.value.supportedEndpoints] : ['/chat/completions'];
};

const toModelConfig = (m: CustomRawModel): UpstreamModelConfig => {
  const label = m.display_name ?? m.name;
  return {
    upstreamModelId: m.id,
    publicModelId: m.id,
    kind: m.kind ?? 'chat',
    supportedEndpoints: endpointsForKind(m.kind),
    ...(label ? { display_name: label } : {}),
    ...(m.limits ? { limits: m.limits } : {}),
    ...(m.cost ? { cost: m.cost } : {}),
  };
};

// Re-derives whenever the top-level endpoint selection changes, so toggling a
// Default LLM Endpoint updates the chat auto rows' checkboxes immediately.
const autoModels = computed(() => fetchedRaw.value.map(toModelConfig));

// Build the draft config the same way the dialog's save() does so the browse
// preview reflects exactly what would be persisted — both call the shared
// core. The browse legitimately omits pathOverrides and the manual model list.
const buildBrowseConfig = () => buildCustomConfigCore(draft.value);

const fetchModels = async () => {
  fetchLoading.value = true;
  fetchError.value = null;
  try {
    const { data, error } = await callApi<{ data: CustomRawModel[] }>(
      () => api.api.upstreams['fetch-models'].$post({ json: { id: props.editId, config: buildBrowseConfig() } }),
    );
    // The toggle may have been turned off while this request was in flight; with
    // fetch disabled the auto block is hidden and dropped on save, so discard the
    // late result rather than repopulating stale auto rows.
    if (!draft.value.modelsFetch.enabled) return;
    if (error) { fetchError.value = error.message; return; }
    fetchedRaw.value = data?.data ?? [];
  } finally {
    fetchLoading.value = false;
  }
};

// Turning fetch off drops the live preview and any error: with the toggle off
// the auto block is hidden and would be dropped on save anyway.
watch(() => draft.value.modelsFetch.enabled, enabled => {
  if (!enabled) {
    fetchedRaw.value = [];
    fetchError.value = null;
  }
});

// Editing a saved upstream with fetch enabled: pull the live list up front (the
// stored secret is reused server-side via editId) so the auto rows are present
// the moment the dialog opens, rather than only after a manual click.
onMounted(() => {
  if (props.editMode && props.editId && draft.value.modelsFetch.enabled) void fetchModels();
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div>
        <label class="mb-1.5 block text-xs font-medium text-gray-500">Base URL</label>
        <Input
          :model-value="draft.baseUrl"
          placeholder="e.g. https://api.openai.com"
          class="font-mono"
          @update:model-value="v => draft = { ...draft, baseUrl: v }"
        />
      </div>
      <div>
        <label class="mb-1.5 block text-xs font-medium text-gray-500">{{ bearerLabel }}</label>
        <SecretInput
          :model-value="draft.bearerToken"
          :placeholder="bearerPlaceholder"
          class="font-mono"
          @update:model-value="v => draft = { ...draft, bearerToken: v }"
        />
      </div>
    </div>

    <div>
      <p class="mb-2 text-xs font-medium text-gray-500">Auth Style</p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label
          class="flex cursor-pointer items-start gap-2 rounded-md border border-white/10 bg-surface-800/50 px-3 py-2 text-xs text-gray-300 transition-colors hover:border-white/20"
          :class="draft.authStyle === 'bearer' && 'border-accent-cyan/40 bg-accent-cyan/5'"
        >
          <input
            type="radio"
            name="customAuthStyle"
            value="bearer"
            class="mt-0.5 accent-accent-cyan"
            :checked="draft.authStyle === 'bearer'"
            @change="draft = { ...draft, authStyle: 'bearer' }"
          >
          <span class="flex flex-col gap-0.5">
            <span class="font-medium">Bearer</span>
            <span class="font-mono text-[10px] text-gray-600">Authorization: Bearer &lt;token&gt;</span>
          </span>
        </label>
        <label
          class="flex cursor-pointer items-start gap-2 rounded-md border border-white/10 bg-surface-800/50 px-3 py-2 text-xs text-gray-300 transition-colors hover:border-white/20"
          :class="draft.authStyle === 'anthropic' && 'border-accent-cyan/40 bg-accent-cyan/5'"
        >
          <input
            type="radio"
            name="customAuthStyle"
            value="anthropic"
            class="mt-0.5 accent-accent-cyan"
            :checked="draft.authStyle === 'anthropic'"
            @change="draft = { ...draft, authStyle: 'anthropic' }"
          >
          <span class="flex flex-col gap-0.5">
            <span class="font-medium">Anthropic</span>
            <span class="font-mono text-[10px] text-gray-600">x-api-key + anthropic-version</span>
          </span>
        </label>
      </div>
    </div>

    <div>
      <p class="mb-2 text-xs font-medium text-gray-500">Supported LLM Endpoints</p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label
          v-for="ep in endpointPills"
          :key="ep.value"
          class="flex items-center gap-2 rounded-md border border-white/10 bg-surface-800/50 px-3 py-2 text-xs text-gray-300 cursor-pointer"
        >
          <input
            type="checkbox"
            class="accent-accent-cyan"
            :checked="draft.supportedEndpoints.includes(ep.value)"
            @change="toggleEndpoint(ep.value)"
          >
          <span class="font-mono text-[11px]">{{ ep.label }}</span>
        </label>
      </div>
    </div>

    <Accordion v-model:open="pathOverridesOpen" label="Path Overrides" :count="overrideCount">
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label v-for="key in pathOverrideKeys" :key="key" class="min-w-0">
          <span class="mb-1 block truncate font-mono text-[10px] text-gray-500">{{ key }}</span>
          <Input
            :model-value="draft.pathOverrides[key]"
            :placeholder="`/v1/${key.replace('_', '/')}`"
            size="sm"
            class="font-mono"
            @update:model-value="v => updatePathOverride(key, v)"
          />
        </label>
      </div>
      <p class="mt-3 text-xs text-gray-400">
        Leave blank to use the OpenAI default <code class="font-mono">/v1/&lt;endpoint&gt;</code>. Count tokens follows the messages path.
      </p>
    </Accordion>

    <!-- Live /models browse toggle. Lives above (outside) the Models section:
         it controls whether auto rows are fetched/shown, not a model entry. -->
    <div>
      <div class="flex items-center gap-2">
        <Switch
          :model-value="draft.modelsFetch.enabled"
          @update:model-value="v => draft = { ...draft, modelsFetch: { ...draft.modelsFetch, enabled: !!v } }"
        />
        <span class="shrink-0 text-xs font-medium" :class="draft.modelsFetch.enabled ? 'text-gray-200' : 'text-gray-500'">
          Fetch model list from <code class="font-mono">/models</code>
        </span>
        <Input
          :model-value="draft.modelsFetch.endpoint"
          placeholder="/v1/models (default)"
          size="sm"
          class="flex-1 font-mono"
          :class="!draft.modelsFetch.enabled && 'pointer-events-none opacity-50'"
          @update:model-value="v => draft = { ...draft, modelsFetch: { ...draft.modelsFetch, endpoint: v } }"
        />
        <Button
          variant="secondary"
          size="sm"
          class="shrink-0"
          :loading="fetchLoading"
          :disabled="!draft.modelsFetch.enabled || fetchLoading"
          @click="fetchModels"
        >Fetch models</Button>
      </div>
      <p v-if="draft.modelsFetch.enabled && fetchLoading" class="mt-1.5 text-[11px] text-gray-500">
        Loading the upstream model list…
      </p>
      <p v-else-if="draft.modelsFetch.enabled" class="mt-1.5 text-[11px] text-gray-500">
        Click <span class="text-gray-300">Fetch models</span> to browse what the upstream <code class="font-mono">/models</code> returns. Auto models are resolved live at request time and are not stored.
      </p>
      <p v-else class="mt-1.5 text-[11px] text-accent-amber">
        Fetch disabled — auto models are hidden and dropped on save. Only overridden (manual) models below persist.
      </p>
      <p v-if="fetchError" class="mt-1.5 text-[11px] text-accent-rose">{{ fetchError }}</p>
    </div>

    <ModelListField
      v-model="draft.models"
      :all-manual="false"
      upstream-id-label="Upstream Model ID"
      flag-provider-kind="custom"
      :auto-models="autoModels"
      :flags="flags"
      :upstream-flag-overrides="upstreamFlagOverrides"
    />
  </div>
</template>
