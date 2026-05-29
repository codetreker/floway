<script setup lang="ts">
import { Badge, Button, Dialog, Input, OverlayScrollbars, Spinner, Switch } from '@floway-dev/ui';
import type { InferRequestType } from 'hono/client';
import { computed, ref, watch } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { AzureUpstreamConfig, CopilotUpstreamConfig, CustomUpstreamConfig, FlagDef, UpstreamModelConfig, UpstreamProviderKind, UpstreamRecord } from '../../api/types.ts';

import Accordion from './Accordion.vue';
import AzureFields from './AzureFields.vue';
import CopilotDeviceFlow from './CopilotDeviceFlow.vue';
import CopilotInfo from './CopilotInfo.vue';
import { buildCustomConfigCore, type CustomDraft } from './customConfig.ts';
import CustomFields from './CustomFields.vue';
import FlagOverridesEditor from './FlagOverridesEditor.vue';
import ModelListField from './ModelListField.vue';
import ProviderRadioCard from './ProviderRadioCard.vue';

const open = defineModel<boolean>('open');

const props = defineProps<{
  mode: 'create' | 'edit';
  provider: UpstreamProviderKind;
  record?: UpstreamRecord;
  nextSortOrder: number;
  flags: FlagDef[];
}>();

const emit = defineEmits<{ saved: [] }>();

const api = useApi();

// Inferred straight off the Hono RPC proxy so the create payload always
// matches the server's createUpstreamBody discriminated union and the patch
// payload matches updateUpstreamBody. Drift between schema and form is a
// compile error on save().
type CreateBody = InferRequestType<typeof api.api.upstreams.$post>['json'];
type PatchBody = InferRequestType<(typeof api.api.upstreams)[':id']['$patch']>['json'];

type PathKey = 'chat_completions' | 'responses' | 'messages' | 'embeddings' | 'images_generations' | 'images_edits';

interface AzureDraft {
  endpoint: string;
  apiKey: string;
  models: UpstreamModelConfig[];
}

const emptyPathOverrides: Record<PathKey, string> = {
  chat_completions: '',
  responses: '',
  messages: '',
  embeddings: '',
  images_generations: '',
  images_edits: '',
};

const blankAzureModel = (): UpstreamModelConfig => ({ upstreamModelId: '', kind: 'chat', supportedEndpoints: ['/responses'] });

const name = ref('');
const enabled = ref(true);
// Sort order is owned by the upstreams list (drag-reorder) — we still persist
// the value so create/patch payloads stay legal, but it's not exposed in the
// form anymore.
const sortOrder = ref<number>(0);
const flagOverrides = ref<Record<string, boolean>>({});
const flagsOpen = ref(false);
const custom = ref<CustomDraft>({ baseUrl: '', authStyle: 'bearer', supportedEndpoints: ['/chat/completions'], bearerToken: '', pathOverrides: { ...emptyPathOverrides }, modelsFetch: { enabled: true, endpoint: '' }, models: [] });
const azure = ref<AzureDraft>({ endpoint: '', apiKey: '', models: [blankAzureModel()] });

// Copilot's catalog is fixed by the upstream and shown read-only. It is fetched
// from the saved upstream's resolved model list; ModelListField still requires a
// manual v-model, so copilotManual stays empty and is never written back.
const copilotModels = ref<UpstreamModelConfig[]>([]);
const copilotManual = ref<UpstreamModelConfig[]>([]);

const loadCopilotModels = async (id: string) => {
  copilotModels.value = [];
  const { data } = await callApi<{ data: UpstreamModelConfig[] }>(
    () => api.api.upstreams[':id'].models.$get({ param: { id } }),
  );
  copilotModels.value = data?.data ?? [];
};

const activeProvider = ref<UpstreamProviderKind>(props.provider);

const saving = ref(false);
const error = ref<string | null>(null);

const seedPathOverrides = (saved: Record<string, string> | null | undefined): Record<PathKey, string> => {
  const result = { ...emptyPathOverrides };
  if (!saved) return result;
  for (const k of Object.keys(emptyPathOverrides) as PathKey[]) {
    const v = saved[k];
    if (typeof v === 'string') result[k] = v;
  }
  return result;
};

const defaultName = (p: UpstreamProviderKind) =>
  p === 'azure' ? 'Azure AI' : p === 'copilot' ? 'GitHub Copilot' : 'Custom upstream';

const reset = () => {
  const r = props.record;
  activeProvider.value = r?.provider ?? props.provider;
  flagsOpen.value = false;
  copilotModels.value = [];
  if (r) {
    name.value = r.name;
    enabled.value = r.enabled;
    sortOrder.value = r.sort_order;
    flagOverrides.value = { ...r.flag_overrides };

    if (r.provider === 'custom') {
      const cfg = r.config as CustomUpstreamConfig;
      custom.value = {
        baseUrl: cfg.baseUrl ?? '',
        authStyle: cfg.authStyle ?? 'bearer',
        supportedEndpoints: [...(cfg.supportedEndpoints ?? [])],
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
      azure.value = {
        endpoint: cfg.endpoint ?? '',
        apiKey: '',
        models: cfg.models ? (JSON.parse(JSON.stringify(cfg.models)) as UpstreamModelConfig[]) : [],
      };
    } else if (r.provider === 'copilot') {
      void loadCopilotModels(r.id);
    }
  } else {
    name.value = defaultName(props.provider);
    enabled.value = true;
    sortOrder.value = props.nextSortOrder;
    flagOverrides.value = {};
    custom.value = { baseUrl: '', authStyle: 'bearer', supportedEndpoints: ['/chat/completions'], bearerToken: '', pathOverrides: { ...emptyPathOverrides }, modelsFetch: { enabled: true, endpoint: '' }, models: [] };
    azure.value = { endpoint: '', apiKey: '', models: [blankAzureModel()] };
  }
  error.value = null;
};

watch(open, v => { if (v) reset(); }, { immediate: true });

// Switching providers in create mode also rewrites the name field if the user
// hasn't customized it (i.e. it still matches the previous provider's
// default).
const setActiveProvider = (next: UpstreamProviderKind) => {
  if (activeProvider.value === next) return;
  const prevDefault = defaultName(activeProvider.value);
  if (name.value === prevDefault) name.value = defaultName(next);
  activeProvider.value = next;
};

const customSecretSet = computed(() => {
  const cfg = props.record?.config as CustomUpstreamConfig | undefined;
  return cfg?.bearerTokenSet === true;
});
const azureSecretSet = computed(() => {
  const cfg = props.record?.config as AzureUpstreamConfig | undefined;
  return cfg?.apiKeySet === true;
});

const buildCustomConfig = (): Extract<CreateBody, { provider: 'custom' }>['config'] => {
  // Save = the shared core (baseUrl/authStyle/endpoints/bearer/modelsFetch) plus
  // the persisted-only fields the live /models browse omits: pathOverrides and
  // the manual model list.
  const config: Extract<CreateBody, { provider: 'custom' }>['config'] = {
    ...buildCustomConfigCore(custom.value),
    models: custom.value.models,
  };
  const overrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(custom.value.pathOverrides)) {
    const trimmed = v.trim();
    if (trimmed) overrides[k] = trimmed;
  }
  if (Object.keys(overrides).length > 0) config.pathOverrides = overrides;
  else if (props.mode === 'edit') config.pathOverrides = null;
  return config;
};

const buildAzureConfig = (): Extract<CreateBody, { provider: 'azure' }>['config'] => {
  const config: Extract<CreateBody, { provider: 'azure' }>['config'] = {
    endpoint: azure.value.endpoint.trim(),
    models: azure.value.models,
  };
  if (azure.value.apiKey.trim()) config.apiKey = azure.value.apiKey.trim();
  return config;
};

const buildCreateBody = (): { ok: true; value: CreateBody } | { ok: false; error: string } => {
  const trimmedName = name.value.trim();
  if (!trimmedName) return { ok: false, error: 'Name is required' };
  const base = {
    name: trimmedName,
    enabled: enabled.value,
    sort_order: sortOrder.value,
    flag_overrides: flagOverrides.value,
  };
  if (activeProvider.value === 'custom') {
    return { ok: true, value: { provider: 'custom', ...base, config: buildCustomConfig() } };
  }
  if (activeProvider.value === 'azure') {
    return { ok: true, value: { provider: 'azure', ...base, config: buildAzureConfig() } };
  }
  // Copilot new-upstream creation flows through the device-flow panel below;
  // save() short-circuits to that path before reaching here.
  return { ok: false, error: 'Copilot upstreams are created through the GitHub device flow.' };
};

const buildPatchBody = (): { ok: true; value: PatchBody } | { ok: false; error: string } => {
  const trimmedName = name.value.trim();
  if (!trimmedName) return { ok: false, error: 'Name is required' };
  const patch: PatchBody = {
    name: trimmedName,
    enabled: enabled.value,
    sort_order: sortOrder.value,
    flag_overrides: flagOverrides.value,
  };
  if (activeProvider.value === 'custom') patch.config = buildCustomConfig();
  else if (activeProvider.value === 'azure') patch.config = buildAzureConfig();
  return { ok: true, value: patch };
};

const save = async () => {
  if (props.mode === 'create') {
    const built = buildCreateBody();
    if (!built.ok) { error.value = built.error; return; }
    saving.value = true;
    error.value = null;
    const { error: err } = await callApi(() => api.api.upstreams.$post({ json: built.value }));
    saving.value = false;
    if (err) { error.value = err.message; return; }
  } else {
    const built = buildPatchBody();
    if (!built.ok) { error.value = built.error; return; }
    saving.value = true;
    error.value = null;
    const { error: err } = await callApi(
      () => api.api.upstreams[':id'].$patch({ param: { id: props.record!.id }, json: built.value }),
    );
    saving.value = false;
    if (err) { error.value = err.message; return; }
  }
  open.value = false;
  emit('saved');
};

// Copilot device-flow finished — close the dialog and let the parent refetch.
const onCopilotCompleted = () => {
  open.value = false;
  emit('saved');
};

// Provider-specific badge tone: custom -> amber, azure -> emerald,
// copilot -> cyan.
const providerBadgeTone = (p: UpstreamProviderKind): 'amber' | 'emerald' | 'cyan' =>
  p === 'azure' ? 'emerald' : p === 'copilot' ? 'cyan' : 'amber';

const titleText = computed(() => {
  if (props.mode === 'edit') return props.record?.name ?? 'Upstream';
  return defaultName(activeProvider.value);
});

// Copilot creation goes through the device-flow path: the upstream record only
// exists once GitHub returns a token, so we hide the Save button until then.
// The rest of the form (name, enable toggle, flag overrides) still renders so
// the operator can preview their pending settings alongside the device-flow
// instructions.
const showSaveButton = computed(() =>
  props.mode === 'edit' || activeProvider.value !== 'copilot',
);
</script>

<template>
  <Dialog v-model:open="open" :title="titleText" size="xl" :padded="false" :close-button="false" :auto-focus-on-open="false">
    <header class="border-b border-white/[0.06] px-4 py-3 sm:px-5">
      <div class="flex items-center justify-between gap-3">
        <div class="flex min-w-0 items-center gap-3">
          <Badge :tone="providerBadgeTone(activeProvider)" class="!uppercase tracking-wide font-semibold">
            {{ activeProvider }}
          </Badge>
          <h3 class="truncate text-base font-semibold text-white">{{ titleText }}</h3>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Switch v-model="enabled" />
          <button
            type="button"
            class="inline-flex h-9 w-9 items-center justify-center rounded-md text-gray-500 hover:bg-white/[0.04] hover:text-white"
            aria-label="Close upstream editor"
            @click="open = false"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
    </header>

    <OverlayScrollbars class="min-h-0 flex-1" content-class="min-h-full" :v-scrollbar-offset="{ x: 2 }">
      <div class="px-4 py-4 sm:px-5">
        <div class="flex flex-col gap-4">
          <div v-if="mode === 'create'">
            <p class="mb-2 text-xs font-medium text-gray-500">Provider</p>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <ProviderRadioCard
                tone="amber"
                :selected="activeProvider === 'custom'"
                title="Custom"
                subtitle="OpenAI-compatible bearer provider"
                @select="setActiveProvider('custom')"
              />
              <ProviderRadioCard
                tone="emerald"
                :selected="activeProvider === 'azure'"
                title="Azure"
                subtitle="Azure OpenAI and Foundry deployments"
                @select="setActiveProvider('azure')"
              />
              <ProviderRadioCard
                tone="cyan"
                :selected="activeProvider === 'copilot'"
                title="Copilot"
                subtitle="Connect a GitHub Copilot account"
                @select="setActiveProvider('copilot')"
              />
            </div>
          </div>

          <div>
            <label class="mb-1.5 block text-xs font-medium text-gray-500">Name</label>
            <Input v-model="name" placeholder="e.g. OpenAI Production" />
          </div>

          <template v-if="activeProvider === 'custom'">
            <CustomFields
              v-model="custom"
              :bearer-token-set="customSecretSet"
              :edit-mode="mode === 'edit'"
              :edit-id="record?.id"
              :flags="flags"
              :upstream-flag-overrides="flagOverrides"
            />
          </template>

          <template v-else-if="activeProvider === 'azure'">
            <AzureFields
              v-model="azure"
              :api-key-set="azureSecretSet"
              :flags="flags"
              :upstream-flag-overrides="flagOverrides"
            />
          </template>

          <template v-else-if="activeProvider === 'copilot'">
            <CopilotInfo v-if="record" :upstream-id="record.id" :config="record.config as CopilotUpstreamConfig" />
            <CopilotDeviceFlow v-else @completed="onCopilotCompleted" />
            <ModelListField
              v-if="record"
              v-model="copilotManual"
              :all-manual="false"
              :read-only="true"
              upstream-id-label="Model"
              flag-provider-kind="copilot"
              :auto-models="copilotModels"
              :flags="flags"
              :upstream-flag-overrides="flagOverrides"
            />
          </template>

          <Accordion v-model:open="flagsOpen" label="Feature Flags" :count="Object.keys(flagOverrides).length">
            <FlagOverridesEditor v-model="flagOverrides" :flags="flags" :provider-kind="activeProvider" name-prefix="upstream-flag" />
          </Accordion>

          <p v-if="error" class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">{{ error }}</p>
        </div>
      </div>
    </OverlayScrollbars>

    <footer class="flex items-center justify-end gap-2 border-t border-white/[0.06] bg-surface-900/40 px-4 py-3 sm:px-5">
      <Button variant="secondary" :disabled="saving" @click="open = false">Cancel</Button>
      <Button v-if="showSaveButton" size="lg" :loading="saving" @click="save">
        <Spinner v-if="saving" class="size-3.5" />
        Save
      </Button>
    </footer>
  </Dialog>
</template>
