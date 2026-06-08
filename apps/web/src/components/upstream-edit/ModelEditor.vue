<script setup lang="ts">
// Auto rows render the same form read-only with a "Switch to Manual" CTA;
// manual rows are fully editable.

import { Button, Input, Select, Switch } from '@floway-dev/ui';
import { computed } from 'vue';

import type { FlagDef, ModelKind, ModelPricing, UpstreamModelConfig, UpstreamProviderKind } from '../../api/types.ts';

import EndpointsField from './EndpointsField.vue';
import FlagOverridesEditor from './FlagOverridesEditor.vue';
import { configOf, defaultEndpointsForKind, publicIdOf, titleFor, type Row } from './modelRows.ts';

const props = defineProps<{
  row: Row | null;
  flags: FlagDef[];
  upstreamFlagOverrides: Record<string, boolean>;
  flagProviderKind: UpstreamProviderKind;
  // "Upstream Model ID" for custom/copilot, "Deployment" for azure.
  upstreamIdLabel: string;
  // True when this manual row's upstream id is fixed (seeded from an auto
  // twin) — the field renders read-only so the row keeps shadowing the twin.
  isUpstreamIdLocked: boolean;
  // Controls visibility of the "Switch to Auto / Manual" toggle in the header.
  hasAutoCounterpart: boolean;
  // True when the parent allows mode switching at all (false for Copilot).
  modeSwitchable: boolean;
}>();

const emit = defineEmits<{
  'patch-config': [patch: Partial<UpstreamModelConfig>];
  'set-mode': [next: 'auto' | 'manual'];
  remove: [];
}>();

const kindOptions: { value: ModelKind; label: string }[] = [
  { value: 'chat', label: 'Chat' },
  { value: 'embedding', label: 'Embedding' },
  { value: 'image', label: 'Image' },
];

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

const config = computed<UpstreamModelConfig | null>(() => props.row ? configOf(props.row) : null);
const editable = computed(() => props.row?.kind === 'manual');
const rowKind = computed<ModelKind>(() => config.value?.kind ?? 'chat');

const patch = (next: Partial<UpstreamModelConfig>) => {
  if (!editable.value) return;
  emit('patch-config', next);
};

const setKind = (k: ModelKind) => {
  if (!editable.value || !config.value) return;
  patch({ kind: k, endpoints: defaultEndpointsForKind(k, config.value.endpoints) });
};

const parseOptionalNumber = (raw: string | number | null | undefined): number | undefined => {
  if (raw === '' || raw === null || raw === undefined) return undefined;
  const num = Number(raw);
  return Number.isFinite(num) ? num : undefined;
};

const updateLimit = (
  key: 'max_context_window_tokens' | 'max_prompt_tokens' | 'max_output_tokens',
  raw: string | number | null | undefined,
) => {
  if (!config.value) return;
  const limits = { ...(config.value.limits ?? {}) };
  const num = parseOptionalNumber(raw);
  if (num === undefined) delete limits[key];
  else limits[key] = num;
  patch({ limits: Object.keys(limits).length > 0 ? limits : undefined });
};

const updateCost = (key: keyof ModelPricing, raw: string | number | null | undefined) => {
  if (!config.value) return;
  const cost = { ...(config.value.cost ?? {}) } as Record<string, unknown>;
  const num = parseOptionalNumber(raw);
  if (num === undefined) delete cost[key];
  else cost[key] = num;
  // Every dimension is independently optional. When all are empty we drop the
  // whole object so the row stores `cost: undefined` rather than an empty stub.
  const hasAny = Object.values(cost).some(v => v !== undefined);
  patch({ cost: hasAny ? (cost as ModelPricing) : undefined });
};

const toggleFlagOverridesEnabled = () => {
  if (!editable.value || !config.value) return;
  if (config.value.flagOverrides?.enabled) {
    patch({ flagOverrides: undefined });
  } else {
    patch({ flagOverrides: { enabled: true, values: { ...(config.value.flagOverrides?.values ?? {}) } } });
  }
};

const updateFlagOverrides = (values: Record<string, boolean>) => {
  patch({ flagOverrides: { enabled: true, values } });
};
</script>

<template>
  <div class="flex min-h-[28rem] flex-col">
    <div v-if="!row || !config" class="flex flex-1 items-center justify-center p-12 text-center text-sm text-gray-500">
      Select a model on the left to edit its settings.
    </div>

    <template v-else>
      <header class="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-5 py-4">
        <div class="min-w-0">
          <h2 class="truncate text-lg font-semibold text-white">{{ titleFor(row) }}</h2>
          <p class="mt-1 flex items-center gap-2 font-mono text-xs text-gray-500">
            <span class="truncate">{{ publicIdOf(row) || '—' }}</span>
            <span v-if="!editable" class="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-gray-400">Auto</span>
            <span v-else class="rounded border border-accent-cyan/30 bg-accent-cyan/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-accent-cyan">Manual</span>
          </p>
        </div>
        <div class="ml-auto flex shrink-0 items-center gap-2">
          <Button
            v-if="modeSwitchable && hasAutoCounterpart && !editable"
            variant="secondary"
            size="sm"
            @click="$emit('set-mode', 'manual')"
          >Switch to Manual</Button>
          <Button
            v-else-if="modeSwitchable && hasAutoCounterpart && editable"
            variant="secondary"
            size="sm"
            @click="$emit('set-mode', 'auto')"
          >Switch to Auto</Button>
          <Button
            v-if="editable"
            variant="danger"
            size="sm"
            @click="$emit('remove')"
          >Remove</Button>
        </div>
      </header>

      <div class="space-y-7 px-5 py-6">

        <section>
          <div class="mb-3 flex items-baseline gap-3">
            <h3 class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Identity</h3>
            <span class="text-[11px] text-gray-500">how the model is exposed publicly and what we send upstream</span>
          </div>
          <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <label class="block space-y-1.5">
              <span class="block text-xs font-medium text-gray-500">Display Name</span>
              <Input
                :model-value="config.display_name"
                :readonly="!editable"
                placeholder="e.g. GPT 5.4 Pro"
                @update:model-value="v => patch({ display_name: v || undefined })"
              />
            </label>
            <label class="block space-y-1.5">
              <span class="block text-xs font-medium text-gray-500">{{ upstreamIdLabel }}</span>
              <Input
                :model-value="config.upstreamModelId"
                :readonly="!editable || isUpstreamIdLocked"
                placeholder="raw upstream id"
                class="font-mono"
                @update:model-value="v => patch({ upstreamModelId: v })"
              />
            </label>
            <label class="block space-y-1.5">
              <span class="block text-xs font-medium text-gray-500">Public Model ID</span>
              <Input
                :model-value="config.publicModelId"
                :readonly="!editable"
                :placeholder="config.upstreamModelId || ''"
                class="font-mono"
                @update:model-value="v => patch({ publicModelId: v || undefined })"
              />
            </label>
            <label class="block space-y-1.5">
              <span class="block text-xs font-medium text-gray-500">Kind</span>
              <Select
                v-if="editable"
                :model-value="rowKind"
                :options="kindOptions"
                @update:model-value="k => setKind(k as ModelKind)"
              />
              <div v-else tabindex="-1" style="pointer-events: none">
                <Select :model-value="rowKind" :options="kindOptions" />
              </div>
            </label>
          </div>
        </section>

        <section v-if="rowKind !== 'embedding'">
          <div class="mb-3 flex items-baseline gap-3">
            <h3 class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Supported Endpoints</h3>
            <span class="text-[11px] text-gray-500">protocols this model responds to</span>
          </div>
          <EndpointsField
            :model-value="config.endpoints ?? {}"
            :kind="rowKind === 'image' ? 'image' : 'chat'"
            :disabled="!editable"
            @update:model-value="v => patch({ endpoints: v })"
          />
        </section>

        <section v-if="rowKind === 'chat'">
          <div class="mb-3 flex items-baseline gap-3">
            <h3 class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Context Limits</h3>
            <span class="text-[11px] text-gray-500">tokens — leave blank to inherit upstream defaults</span>
          </div>
          <div class="grid gap-3 sm:grid-cols-3">
            <label class="block space-y-1.5">
              <span class="block text-xs font-medium text-gray-500">Context Window</span>
              <Input
                type="number"
                :model-value="config.limits?.max_context_window_tokens"
                :readonly="!editable"
                placeholder="e.g. 1050000"
                class="font-mono"
                @update:model-value="v => updateLimit('max_context_window_tokens', v)"
              />
            </label>
            <label class="block space-y-1.5">
              <span class="block text-xs font-medium text-gray-500">Prompt Tokens</span>
              <Input
                type="number"
                :model-value="config.limits?.max_prompt_tokens"
                :readonly="!editable"
                placeholder="e.g. 922000"
                class="font-mono"
                @update:model-value="v => updateLimit('max_prompt_tokens', v)"
              />
            </label>
            <label class="block space-y-1.5">
              <span class="block text-xs font-medium text-gray-500">Output Tokens</span>
              <Input
                type="number"
                :model-value="config.limits?.max_output_tokens"
                :readonly="!editable"
                placeholder="e.g. 128000"
                class="font-mono"
                @update:model-value="v => updateLimit('max_output_tokens', v)"
              />
            </label>
          </div>
        </section>

        <section>
          <div class="mb-3 flex items-baseline gap-3">
            <h3 class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Pricing</h3>
            <span class="text-[11px] text-gray-500">$ per million tokens — used for usage attribution</span>
          </div>
          <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <label v-for="dim in PRICING_BY_KIND[rowKind]" :key="dim" class="block space-y-1.5">
              <span class="block text-xs font-medium text-gray-500">{{ PRICING_LABELS[dim] }}</span>
              <Input
                type="number"
                :model-value="config.cost?.[dim]"
                :readonly="!editable"
                placeholder="$/MTok"
                class="font-mono"
                @update:model-value="v => updateCost(dim, v)"
              />
            </label>
          </div>
        </section>

        <section>
          <div class="mb-3 flex items-baseline gap-3">
            <h3 class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Override Feature Flags</h3>
            <span class="text-[11px] text-gray-500">applied on top of upstream-level flags; <code class="font-mono">Inherit</code> reflects the upstream-resolved value</span>
            <Switch
              v-if="editable"
              :model-value="config.flagOverrides?.enabled === true"
              class="ml-auto"
              @update:model-value="toggleFlagOverridesEnabled"
            />
            <Switch v-else :model-value="false" disabled class="ml-auto" />
          </div>
          <FlagOverridesEditor
            v-if="editable && config.flagOverrides?.enabled"
            :model-value="config.flagOverrides?.values ?? {}"
            :flags="flags"
            :provider-kind="flagProviderKind"
            :inherited-overrides="upstreamFlagOverrides"
            :name-prefix="`${row.uiId}-flag`"
            class="max-h-72"
            @update:model-value="updateFlagOverrides"
          />
          <p v-else-if="editable" class="text-[11px] text-gray-600">
            Toggle on to override individual flags for this model only.
          </p>
          <p v-else class="text-[11px] text-gray-600">
            Auto models inherit upstream flags. Switch to Manual to override per model.
          </p>
        </section>

      </div>
    </template>
  </div>
</template>
