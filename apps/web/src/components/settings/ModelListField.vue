<script setup lang="ts">
import { Button, Card, cn, Input, OverlayScrollbars, Select, Switch } from '@floway-dev/ui';
import Prism from 'prismjs';
import 'prismjs/components/prism-json.js';
import { computed, reactive, ref, useTemplateRef, watch } from 'vue';

import type { FlagDef, ModelKind, ModelPricing, UpstreamModelConfig, UpstreamProviderKind } from '../../api/types.ts';

import FlagOverridesEditor from './FlagOverridesEditor.vue';

// The persisted value is the manual model list only; auto rows are resolved
// live from a fresh /models result and never serialized. A manual entry whose
// upstreamModelId matches an auto entry overrides (hides) that auto twin.
const models = defineModel<UpstreamModelConfig[]>({ required: true });

const props = withDefaults(defineProps<{
  allManual: boolean;
  upstreamIdLabel: string;
  autoModels?: UpstreamModelConfig[];
  flags: FlagDef[];
  upstreamFlagOverrides: Record<string, boolean>;
  flagProviderKind: UpstreamProviderKind;
  // Fully read-only: every row is shown but cannot be edited, converted, added,
  // or removed (used for Copilot, whose catalog is fixed by the upstream).
  readOnly?: boolean;
}>(), {
  autoModels: () => [],
  readOnly: false,
});

const kindOptions: { value: ModelKind; label: string }[] = [
  { value: 'chat', label: 'Chat' },
  { value: 'embedding', label: 'Embedding' },
  { value: 'image', label: 'Image' },
];

// Public endpoint paths offered per kind. Embedding has no choice (it always
// routes to /embeddings); chat and image expose a checkbox set.
const CHAT_ENDPOINTS = [
  { value: '/chat/completions', label: '/chat/completions' },
  { value: '/responses', label: '/responses' },
  { value: '/v1/messages', label: '/messages' },
];
const IMAGE_ENDPOINTS = [
  { value: '/v1/images/generations', label: '/images/generations' },
  { value: '/v1/images/edits', label: '/images/edits' },
];

// Pricing dimensions surfaced per kind. Hidden dimensions keep their stored
// value — the editor never clears them, it just stops showing them.
const PRICING_LABELS: Record<string, string> = {
  input: 'Input ($/MTok)',
  input_cache_read: 'Cache Read ($/MTok)',
  input_cache_write: 'Cache Write ($/MTok)',
  input_image: 'Image Input ($/MTok)',
  output: 'Output ($/MTok)',
  output_image: 'Image Output ($/MTok)',
};
const PRICING_BY_KIND: Record<ModelKind, (keyof ModelPricing)[]> = {
  chat: ['input', 'input_cache_read', 'input_cache_write', 'output'],
  embedding: ['input'],
  image: ['input', 'input_image', 'output', 'output_image'],
};

const kindFromEndpoints = (endpoints: string[] | undefined): ModelKind => {
  const set = new Set(endpoints ?? []);
  if (set.has('/embeddings') || set.has('/v1/embeddings')) return 'embedding';
  if ([...set].some(e => e.includes('/images/'))) return 'image';
  return 'chat';
};

const kindFor = (config: UpstreamModelConfig): ModelKind => config.kind ?? kindFromEndpoints(config.supportedEndpoints);

// The endpoint set to apply when switching INTO a kind, preserving any current
// endpoints that already belong to that kind so a chat model keeps its protocol
// choices across an accidental round-trip.
const defaultEndpointsForKind = (kind: ModelKind, current: string[] | undefined): string[] => {
  const set = new Set(current ?? []);
  if (kind === 'embedding') return ['/embeddings'];
  const options = (kind === 'image' ? IMAGE_ENDPOINTS : CHAT_ENDPOINTS).map(e => e.value);
  const kept = options.filter(v => set.has(v));
  return kept.length ? kept : (kind === 'image' ? options : ['/chat/completions']);
};

const endpointOptionsForKind = (kind: ModelKind) => (kind === 'image' ? IMAGE_ENDPOINTS : CHAT_ENDPOINTS);

// One unified, ordered list of row descriptors. Each row is tagged with a
// stable uiId (kept off the persisted data object) so converting a row in place
// (auto <-> manual) never makes it jump, and so focus/expanded state survive
// re-renders. Manual rows carry their
// own editable config; auto rows reference a live /models snapshot and stay
// read-only. The persisted models v-model is derived as the manual subset, in
// list order.
type Row =
  | { uiId: string; kind: 'manual'; config: UpstreamModelConfig }
  | { uiId: string; kind: 'auto'; auto: UpstreamModelConfig };

let nextUiId = 0;
const newUiId = () => `m${++nextUiId}`;

const rows = ref<Row[]>([]);
const expanded = reactive<Record<string, boolean>>({});

// Reconcile the unified row list from the manual models v-model and the live
// autoModels prop. Existing rows keep their position and uiId when their
// identity (manual config object / auto upstreamModelId) still matches, so
// external prop churn (e.g. a re-fetch) does not reorder or collapse rows the
// user is editing. New manual rows precede the auto block; new auto ids are
// appended at the bottom.
const reconcile = () => {
  const manual = models.value;
  // Normalize kind on every manual entry (older configs predate the field) so
  // the form, the JSON view, and the next save all carry an explicit kind.
  for (const c of manual) if (!c.kind) c.kind = kindFromEndpoints(c.supportedEndpoints);
  const manualIds = new Set(manual.map(m => m.upstreamModelId));
  const auto = (props.autoModels ?? []).filter(a => !manualIds.has(a.upstreamModelId));

  const prev = rows.value;
  const next: Row[] = [];
  const placedManual = new Set<UpstreamModelConfig>();
  const placedAuto = new Set<string>();

  for (const row of prev) {
    if (row.kind === 'manual') {
      if (manual.includes(row.config)) {
        next.push(row);
        placedManual.add(row.config);
      }
    } else {
      const live = auto.find(a => a.upstreamModelId === row.auto.upstreamModelId);
      if (live) {
        // Refresh the snapshot in place so a re-fetch updates read-only metadata
        // without disturbing the row's identity/position.
        row.auto = live;
        next.push(row);
        placedAuto.add(row.auto.upstreamModelId);
      }
    }
  }

  for (const config of manual) {
    if (!placedManual.has(config)) {
      const insertAt = next.findIndex(r => r.kind === 'auto');
      const row: Row = { uiId: newUiId(), kind: 'manual', config };
      if (insertAt === -1) next.push(row); else next.splice(insertAt, 0, row);
    }
  }

  for (const a of auto) {
    if (!placedAuto.has(a.upstreamModelId)) {
      next.push({ uiId: newUiId(), kind: 'auto', auto: a });
    }
  }

  rows.value = next;
};

watch([models, () => props.autoModels], reconcile, { immediate: true, deep: false });

const isExpanded = (uiId: string) => expanded[uiId] === true;
const toggleExpanded = (uiId: string) => {
  expanded[uiId] = !expanded[uiId];
};

// Field edits mutate the manual config object in place via Object.assign,
// keeping the reference (and the row's uiId) stable. The v-for key based on
// uiId therefore doesn't churn, so the open/closed state and focused input
// survive every keystroke. The v-model array is then re-emitted (same element
// references) so the parent draft stays in sync.
const emitModels = () => {
  models.value = rows.value.filter((r): r is Extract<Row, { kind: 'manual' }> => r.kind === 'manual').map(r => r.config);
};

const patchConfig = (config: UpstreamModelConfig, patch: Partial<UpstreamModelConfig>) => {
  Object.assign(config, patch);
  for (const key of Object.keys(patch) as (keyof UpstreamModelConfig)[]) {
    if (patch[key] === undefined) delete (config as unknown as Record<string, unknown>)[key];
  }
  emitModels();
};

const setKind = (config: UpstreamModelConfig, kind: ModelKind) => {
  patchConfig(config, { kind, supportedEndpoints: defaultEndpointsForKind(kind, config.supportedEndpoints) });
};

const toggleEndpoint = (config: UpstreamModelConfig, ep: string, on: boolean) => {
  const set = new Set(config.supportedEndpoints ?? []);
  if (on) set.add(ep); else set.delete(ep);
  patchConfig(config, { supportedEndpoints: Array.from(set) });
};

const updateLimit = (config: UpstreamModelConfig, key: 'max_context_window_tokens' | 'max_prompt_tokens' | 'max_output_tokens', value: string) => {
  const limits = { ...(config.limits ?? {}) };
  const num = value === '' ? undefined : Number(value);
  if (num === undefined || !Number.isFinite(num)) delete limits[key]; else limits[key] = num;
  patchConfig(config, { limits: Object.keys(limits).length > 0 ? limits : undefined });
};

const COST_KEYS = ['input', 'input_cache_read', 'input_cache_write', 'input_image', 'output', 'output_image'] as const;

const updateCost = (config: UpstreamModelConfig, key: (typeof COST_KEYS)[number], value: string) => {
  const cost = { ...(config.cost ?? {}) } as Record<string, unknown>;
  const num = value === '' ? undefined : Number(value);
  if (num === undefined || !Number.isFinite(num)) delete cost[key]; else cost[key] = num;
  // Every dimension is independently optional. When all are empty we drop the
  // whole object so the row stores `cost: undefined` rather than an empty stub.
  const hasAny = COST_KEYS.some(k => cost[k] !== undefined);
  patchConfig(config, { cost: hasAny ? (cost as UpstreamModelConfig['cost']) : undefined });
};

const toggleFlagOverridesEnabled = (config: UpstreamModelConfig) => {
  if (config.flagOverrides?.enabled) {
    patchConfig(config, { flagOverrides: undefined });
  } else {
    patchConfig(config, { flagOverrides: { enabled: true, values: { ...(config.flagOverrides?.values ?? {}) } } });
  }
};

const titleFor = (row: Row): string => {
  const c = configOf(row);
  return (c.display_name?.trim() || c.upstreamModelId?.trim() || 'Untitled model');
};

// Manual rows are editable and bind to their own config object; auto rows render
// the same form read-only against their live /models snapshot. The unified card
// template reads through configOf() and gates every handler on isEditable().
const configOf = (row: Row): UpstreamModelConfig => row.kind === 'manual' ? row.config : row.auto;
const isEditable = (row: Row): row is Extract<Row, { kind: 'manual' }> => row.kind === 'manual';

// A row's upstreamModelId becomes readonly once it was seeded from an auto twin:
// it must keep matching the upstream id so the data-plane filter that hides the
// auto duplicate keeps working. Pure hand-added rows have no such constraint.
const lockedUpstreamId = reactive(new Set<string>());
const isUpstreamIdLocked = (row: Row) => row.kind === 'manual' && lockedUpstreamId.has(row.uiId);

// The Auto pill is only meaningful when there is an auto twin to fall back to.
// A pure-manual row (no current auto counterpart, and not currently auto) can't
// be switched to Auto, so it shows neither pill.
const autoIds = computed(() => new Set((props.autoModels ?? []).map(a => a.upstreamModelId)));
const hasAutoCounterpart = (row: Row) => {
  if (row.kind === 'auto') return true;
  return autoIds.value.has(row.config.upstreamModelId);
};
const showModePills = (row: Row) => !props.readOnly && !props.allManual && hasAutoCounterpart(row);

const blankConfig = (): UpstreamModelConfig => ({ upstreamModelId: '', kind: 'chat', supportedEndpoints: ['/chat/completions'] });

const seedFromAuto = (auto: UpstreamModelConfig): UpstreamModelConfig => ({
  upstreamModelId: auto.upstreamModelId,
  kind: auto.kind ?? kindFromEndpoints(auto.supportedEndpoints),
  supportedEndpoints: auto.supportedEndpoints?.length ? [...auto.supportedEndpoints] : ['/chat/completions'],
  ...(auto.publicModelId ? { publicModelId: auto.publicModelId } : {}),
  ...(auto.display_name ? { display_name: auto.display_name } : {}),
  ...(auto.limits ? { limits: { ...auto.limits } } : {}),
  ...(auto.cost ? { cost: { ...auto.cost } } : {}),
});

const setMode = (uiId: string, mode: 'auto' | 'manual') => {
  const index = rows.value.findIndex(r => r.uiId === uiId);
  const row = rows.value[index];
  if (!row) return;
  if (mode === 'manual' && row.kind === 'auto') {
    // Seed an editable manual entry from the auto snapshot, keep the position,
    // and lock its upstreamModelId so it keeps shadowing the auto twin.
    const config = seedFromAuto(row.auto);
    rows.value.splice(index, 1, { uiId, kind: 'manual', config });
    lockedUpstreamId.add(uiId);
    emitModels();
  } else if (mode === 'auto' && row.kind === 'manual') {
    // Drop the manual override and restore its auto twin in place, reusing the
    // same uiId so the row keeps its expanded state and position instead of
    // being re-created (and collapsed) by the reconcile.
    lockedUpstreamId.delete(uiId);
    const twin = (props.autoModels ?? []).find(a => a.upstreamModelId === row.config.upstreamModelId);
    if (twin) rows.value.splice(index, 1, { uiId, kind: 'auto', auto: twin });
    else rows.value.splice(index, 1);
    emitModels();
  }
};

const addModel = () => {
  const config = blankConfig();
  const insertAt = rows.value.findIndex(r => r.kind === 'auto');
  const uiId = newUiId();
  const row: Row = { uiId, kind: 'manual', config };
  if (insertAt === -1) rows.value.push(row); else rows.value.splice(insertAt, 0, row);
  expanded[uiId] = true;
  emitModels();
};

const removeRow = (uiId: string) => {
  delete expanded[uiId];
  lockedUpstreamId.delete(uiId);
  rows.value = rows.value.filter(r => r.uiId !== uiId);
  emitModels();
};

defineExpose({ addModel });

/* ============================ JSON mode ============================ */

const mode = ref<'ui' | 'json'>('ui');
const jsonText = ref('');
const jsonError = ref<string | null>(null);
const jsonHighlightRef = useTemplateRef<HTMLPreElement>('jsonHighlightRef');

const serializeManual = () =>
  JSON.stringify(models.value.map(c => ({ ...c })), null, 2);

const switchMode = (next: 'ui' | 'json') => {
  if (mode.value === next) return;
  if (next === 'json') {
    jsonText.value = serializeManual();
    jsonError.value = null;
    mode.value = 'json';
    return;
  }
  try {
    const parsed = JSON.parse(jsonText.value);
    if (!Array.isArray(parsed)) throw new Error('models JSON must be an array');
    models.value = parsed as UpstreamModelConfig[];
    jsonError.value = null;
    mode.value = 'ui';
  } catch (e) {
    jsonError.value = `Cannot leave JSON mode: ${e instanceof Error ? e.message : String(e)}`;
  }
};

watch(models, () => {
  if (mode.value !== 'ui') return;
  jsonText.value = serializeManual();
}, { deep: true });

const onJsonInput = (text: string) => {
  jsonText.value = text;
  jsonError.value = null;
};

const isJsonMode = computed(() => mode.value === 'json');
const highlightedJson = computed(() => Prism.highlight(jsonText.value, Prism.languages.json!, 'json'));

const syncJsonScroll = (event: Event) => {
  const target = event.target as HTMLTextAreaElement | null;
  const highlight = jsonHighlightRef.value;
  if (!target || !highlight) return;
  highlight.scrollTop = target.scrollTop;
  highlight.scrollLeft = target.scrollLeft;
};
</script>

<template>
  <div>
    <div class="mb-2 flex items-center justify-between gap-3">
      <p class="text-xs font-medium text-gray-500">Models</p>
      <div v-if="!readOnly && !isJsonMode" class="flex items-center gap-2">
        <Button variant="secondary" size="sm" @click="addModel">Add Model</Button>
        <Button variant="secondary" size="sm" @click="switchMode('json')">Edit as JSON</Button>
      </div>
      <Button v-else-if="!readOnly" variant="secondary" size="sm" @click="switchMode('ui')">Edit with UI</Button>
    </div>

    <OverlayScrollbars v-if="!isJsonMode" :class="cn('max-h-[14rem]')" no-tabindex :v-scrollbar-offset="{ x: 2 }">
      <div class="space-y-2 pr-1">
      <Card v-for="row in rows" :key="row.uiId" :padded="false" class="overflow-hidden" :class="row.kind === 'auto' && 'bg-surface-800/30'">
        <header class="flex items-center justify-between gap-2 px-3 py-2">
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
            :aria-expanded="isExpanded(row.uiId)"
            @click="toggleExpanded(row.uiId)"
          >
            <span class="truncate text-sm font-medium" :class="row.kind === 'manual' ? 'text-white' : 'text-gray-300'">{{ titleFor(row) }}</span>
            <svg
              class="size-4 shrink-0 text-gray-400 transition-transform"
              :class="isExpanded(row.uiId) && 'rotate-180'"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>

          <div class="flex shrink-0 items-center gap-2">
            <fieldset v-if="showModePills(row)" class="flex shrink-0 items-center gap-1 text-[11px]">
              <button
                type="button"
                class="flex cursor-pointer items-center rounded border px-1.5 py-0.5 transition-colors"
                :class="row.kind === 'auto' ? 'border-white/20 bg-white/10 text-gray-200' : 'border-white/10 text-gray-500 hover:bg-white/5'"
                @click="setMode(row.uiId, 'auto')"
              >Auto</button>
              <button
                type="button"
                class="flex cursor-pointer items-center rounded border px-1.5 py-0.5 transition-colors"
                :class="row.kind === 'manual' ? 'border-accent-cyan/40 bg-accent-cyan/20 text-accent-cyan' : 'border-white/10 text-gray-500 hover:bg-white/5'"
                @click="setMode(row.uiId, 'manual')"
              >Manual</button>
            </fieldset>
            <button
              v-if="row.kind === 'manual'"
              type="button"
              class="grid size-7 shrink-0 place-items-center rounded text-gray-500 hover:bg-surface-700 hover:text-accent-rose"
              aria-label="Remove model"
              @click="removeRow(row.uiId)"
            >
              <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
        </header>

        <div v-if="isExpanded(row.uiId)" class="space-y-4 border-t border-white/[0.06] p-3">
          <!-- One card body for both kinds: manual rows are fully editable, auto
               rows render the same form read-only (readonly inputs, a
               non-interactive select, a disabled flag switch) so upstream
               metadata stays visible without being greyed out. -->
          <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <label class="block space-y-1.5">
              <span class="block text-xs font-medium text-gray-500">Display Name</span>
              <Input :model-value="configOf(row).display_name" :readonly="!isEditable(row)" placeholder="e.g. GPT 5.4 Pro" size="sm" @update:model-value="v => isEditable(row) && patchConfig(row.config, { display_name: v || undefined })" />
            </label>
            <label class="block space-y-1.5">
              <span class="block text-xs font-medium text-gray-500">{{ upstreamIdLabel }}</span>
              <Input :model-value="configOf(row).upstreamModelId" :readonly="!isEditable(row) || isUpstreamIdLocked(row)" placeholder="raw upstream id" size="sm" class="font-mono" @update:model-value="v => isEditable(row) && patchConfig(row.config, { upstreamModelId: v })" />
            </label>
            <label class="block space-y-1.5">
              <span class="block text-xs font-medium text-gray-500">Public Model ID</span>
              <Input :model-value="isEditable(row) ? row.config.publicModelId : (row.auto.publicModelId ?? row.auto.upstreamModelId)" :readonly="!isEditable(row)" :placeholder="configOf(row).upstreamModelId || ''" size="sm" class="font-mono" @update:model-value="v => isEditable(row) && patchConfig(row.config, { publicModelId: v || undefined })" />
            </label>
            <label class="block space-y-1.5">
              <span class="block text-xs font-medium text-gray-500">Kind</span>
              <Select v-if="isEditable(row)" :model-value="kindFor(row.config)" :options="kindOptions" size="sm" @update:model-value="k => setKind(row.config, k as ModelKind)" />
              <div v-else tabindex="-1" style="pointer-events: none">
                <Select :model-value="kindFor(row.auto)" :options="kindOptions" size="sm" />
              </div>
            </label>
          </div>

          <div v-if="kindFor(configOf(row)) !== 'embedding'" class="space-y-1.5">
            <span class="block text-xs font-medium text-gray-500">Supported Endpoints</span>
            <div class="flex flex-wrap gap-2">
              <label v-for="ep in endpointOptionsForKind(kindFor(configOf(row)))" :key="ep.value" class="inline-flex items-center gap-1.5 rounded-md border border-white/[0.06] bg-surface-800/40 px-2 py-1 text-xs text-gray-200" :class="!isEditable(row) && 'opacity-80'">
                <input type="checkbox" class="accent-accent-cyan" :checked="configOf(row).supportedEndpoints?.includes(ep.value)" :disabled="!isEditable(row)" @change="(e: Event) => isEditable(row) && toggleEndpoint(row.config, ep.value, (e.target as HTMLInputElement).checked)">
                <code class="font-mono text-[11px]">{{ ep.label }}</code>
              </label>
            </div>
          </div>

          <div v-if="kindFor(configOf(row)) === 'chat'" class="space-y-1.5">
            <p class="text-xs font-semibold text-gray-400">Context Limits</p>
            <div class="grid gap-3 sm:grid-cols-3">
              <label class="block space-y-1">
                <span class="block text-[11px] font-medium text-gray-500">Context Window</span>
                <Input type="number" :model-value="configOf(row).limits?.max_context_window_tokens" :readonly="!isEditable(row)" placeholder="e.g. 1050000" size="sm" class="font-mono" @update:model-value="v => isEditable(row) && updateLimit(row.config, 'max_context_window_tokens', String(v))" />
              </label>
              <label class="block space-y-1">
                <span class="block text-[11px] font-medium text-gray-500">Prompt Tokens</span>
                <Input type="number" :model-value="configOf(row).limits?.max_prompt_tokens" :readonly="!isEditable(row)" placeholder="e.g. 922000" size="sm" class="font-mono" @update:model-value="v => isEditable(row) && updateLimit(row.config, 'max_prompt_tokens', String(v))" />
              </label>
              <label class="block space-y-1">
                <span class="block text-[11px] font-medium text-gray-500">Output Tokens</span>
                <Input type="number" :model-value="configOf(row).limits?.max_output_tokens" :readonly="!isEditable(row)" placeholder="e.g. 128000" size="sm" class="font-mono" @update:model-value="v => isEditable(row) && updateLimit(row.config, 'max_output_tokens', String(v))" />
              </label>
            </div>
          </div>

          <div class="space-y-1.5">
            <p class="text-xs font-semibold text-gray-400">Pricing</p>
            <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <label v-for="dim in PRICING_BY_KIND[kindFor(configOf(row))]" :key="dim" class="block space-y-1">
                <span class="block text-[11px] font-medium text-gray-500">{{ PRICING_LABELS[dim] }}</span>
                <Input type="number" :model-value="configOf(row).cost?.[dim]" :readonly="!isEditable(row)" placeholder="$/MTok" size="sm" class="font-mono" @update:model-value="v => isEditable(row) && updateCost(row.config, dim, String(v))" />
              </label>
            </div>
          </div>

          <div>
            <div class="mb-2 flex items-center justify-between">
              <p class="text-xs font-semibold text-gray-400">Override Feature Flags</p>
              <Switch v-if="isEditable(row)" :model-value="row.config.flagOverrides?.enabled === true" @update:model-value="() => toggleFlagOverridesEnabled(row.config)" />
              <Switch v-else :model-value="false" disabled />
            </div>
            <div v-if="isEditable(row) && row.config.flagOverrides?.enabled">
              <FlagOverridesEditor
                :model-value="row.config.flagOverrides?.values ?? {}"
                :flags="flags"
                :provider-kind="flagProviderKind"
                :inherited-overrides="upstreamFlagOverrides"
                :name-prefix="`${row.uiId}-flag`"
                class="max-h-56"
                @update:model-value="values => patchConfig(row.config, { flagOverrides: { enabled: true, values } })"
              />
            </div>
          </div>
        </div>
      </Card>

      <div v-if="rows.length === 0" class="rounded-2xl border border-dashed border-white/[0.08] p-4 text-center text-xs text-gray-500">
        <template v-if="readOnly">No models reported by this upstream yet.</template>
        <template v-else>No models yet. <template v-if="allManual">Add one.</template><template v-else>Add one manually, or fetch the upstream list.</template></template>
      </div>
      </div>
    </OverlayScrollbars>

    <div v-else class="rounded-lg border border-white/10 bg-surface-900/70">
      <div class="json-editor relative h-72 overflow-hidden rounded-lg">
        <pre
          ref="jsonHighlightRef"
          aria-hidden="true"
          class="absolute inset-0 m-0 overflow-auto whitespace-pre p-3 text-[11px] font-mono leading-[1.6]"
        ><code class="language-json" v-html="highlightedJson" /></pre>
        <textarea
          :value="jsonText"
          spellcheck="false"
          wrap="off"
          aria-label="Models JSON"
          class="absolute inset-0 !m-0 h-full w-full resize-none overflow-auto rounded-lg border-0 bg-transparent p-3 text-[11px] font-mono leading-[1.6] text-transparent caret-gray-100 outline-none selection:bg-accent-cyan/25 focus:border-0 focus:ring-0"
          style="color: transparent; -webkit-text-fill-color: transparent; caret-color: #e0e0e0;"
          @input="onJsonInput(($event.target as HTMLTextAreaElement).value)"
          @scroll="syncJsonScroll"
        />
      </div>
      <p v-if="jsonError" class="border-t border-accent-rose/20 px-3 py-2 text-xs text-accent-rose">{{ jsonError }}</p>
      <p class="border-t border-white/[0.06] px-3 py-2 text-xs text-gray-500">Manual (overridden) models only. Auto models are resolved live and never serialized.</p>
    </div>
  </div>
</template>

<style scoped>
.json-editor :deep(code[class*='language-']),
.json-editor :deep(pre[class*='language-']) {
  background: transparent;
  text-shadow: none;
  font-family: 'JetBrains Mono', monospace;
}

.json-editor :deep(.token.comment),
.json-editor :deep(.token.prolog),
.json-editor :deep(.token.doctype),
.json-editor :deep(.token.cdata) {
  color: #8b949e;
}

.json-editor :deep(.token.punctuation),
.json-editor :deep(.token.operator) {
  color: #c9d1d9;
}

.json-editor :deep(.token.property),
.json-editor :deep(.token.tag),
.json-editor :deep(.token.boolean),
.json-editor :deep(.token.number),
.json-editor :deep(.token.constant),
.json-editor :deep(.token.symbol) {
  color: #79c0ff;
}

.json-editor :deep(.token.selector),
.json-editor :deep(.token.attr-name),
.json-editor :deep(.token.string),
.json-editor :deep(.token.char),
.json-editor :deep(.token.builtin) {
  color: #a5d6ff;
}

.json-editor :deep(.token.atrule),
.json-editor :deep(.token.attr-value),
.json-editor :deep(.token.keyword) {
  color: #ff7b72;
}

.json-editor :deep(.token.function),
.json-editor :deep(.token.class-name) {
  color: #d2a8ff;
}

.json-editor :deep(.token.regex),
.json-editor :deep(.token.important),
.json-editor :deep(.token.variable) {
  color: #ffa657;
}
</style>
