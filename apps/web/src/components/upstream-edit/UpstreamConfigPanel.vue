<script setup lang="ts">
import { Input, Switch, TagCombobox } from '@floway-dev/ui';

import type { CopilotQuotaSnapshot, FlagDef, UpstreamProviderKind, UpstreamRecord } from '../../api/types.ts';

import AzureConfigPanel from './AzureConfigPanel.vue';
import CodexConfigPanel from './CodexConfigPanel.vue';
import CopilotConfigPanel from './CopilotConfigPanel.vue';
import CustomConfigPanel from './CustomConfigPanel.vue';
import type { AzureDraft, CustomDraft } from './customConfig.ts';
import FlagOverridesEditor from './FlagOverridesEditor.vue';
import ProviderPicker from './ProviderPicker.vue';

const activeProvider = defineModel<UpstreamProviderKind>('provider', { required: true });
const name = defineModel<string>('name', { required: true });
const enabled = defineModel<boolean>('enabled', { required: true });
const flagOverrides = defineModel<Record<string, boolean>>('flagOverrides', { required: true });
const disabledIds = defineModel<string[]>('disabledIds', { required: true });
const customDraft = defineModel<CustomDraft>('custom', { required: true });
const azureDraft = defineModel<AzureDraft>('azure', { required: true });

defineProps<{
  mode: 'create' | 'edit';
  record: UpstreamRecord | null;
  flags: FlagDef[];
  customBearerTokenSet: boolean;
  azureApiKeySet: boolean;
  fetchLoading: boolean;
  fetchError: string | null;
  fetchStatus: string | null;
  // Public ids currently surfaced in the model grid — fed to the
  // disabled-models combobox as autocomplete suggestions. Orphan ids in
  // `disabledIds` (no longer present in the catalog) still render as
  // removable chips because TagCombobox falls back to the raw id when an
  // entry is not in the items map.
  availableModelItems: { value: string; label: string }[];
  initialCopilotQuota?: CopilotQuotaSnapshot | null;
  initialCopilotQuotaError?: string | null;
}>();

defineEmits<{
  'fetch-models': [];
  'copilot-completed': [upstream: UpstreamRecord | undefined];
  'codex-imported': [upstream: UpstreamRecord];
  'codex-error': [message: string];
}>();

const providerBadgeClass = (kind: UpstreamProviderKind) => {
  switch (kind) {
  case 'azure': return 'border-accent-emerald/30 bg-accent-emerald/10 text-accent-emerald';
  case 'copilot': return 'border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan';
  case 'codex': return 'border-accent-violet/30 bg-accent-violet/10 text-accent-violet';
  case 'custom':
  default: return 'border-accent-amber/30 bg-accent-amber/10 text-accent-amber';
  }
};
</script>

<template>
  <aside class="glass-card flex min-w-0 flex-col">
    <header class="flex shrink-0 items-center gap-3 border-b border-white/[0.06] px-5 py-4">
      <span
        class="rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
        :class="providerBadgeClass(activeProvider)"
      >{{ activeProvider }}</span>
      <h2 class="min-w-0 truncate text-sm font-semibold text-white">
        {{ name || (mode === 'create' ? 'New upstream' : 'Upstream') }}
      </h2>
      <Switch v-model="enabled" class="ml-auto" />
    </header>

    <div class="flex min-h-0 flex-1 flex-col gap-6 px-5 py-5">

      <section v-if="mode === 'create'" class="shrink-0">
        <p class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Provider</p>
        <ProviderPicker v-model="activeProvider" />
      </section>

      <section v-if="!(mode === 'create' && (activeProvider === 'copilot' || activeProvider === 'codex'))" class="shrink-0">
        <label class="mb-1.5 block text-xs font-medium text-gray-500">Name</label>
        <Input v-model="name" placeholder="e.g. OpenAI Production" />
      </section>

      <section v-if="activeProvider === 'custom'" class="shrink-0">
        <CustomConfigPanel
          v-model="customDraft"
          :bearer-token-set="customBearerTokenSet"
          :edit-mode="mode === 'edit'"
          :fetch-loading="fetchLoading"
          :fetch-error="fetchError"
          :fetch-status="fetchStatus"
          @fetch-models="$emit('fetch-models')"
        />
      </section>

      <section v-else-if="activeProvider === 'azure'" class="shrink-0">
        <AzureConfigPanel
          v-model="azureDraft"
          :api-key-set="azureApiKeySet"
          :edit-mode="mode === 'edit'"
        />
      </section>

      <section v-else-if="activeProvider === 'copilot'" class="shrink-0">
        <CopilotConfigPanel
          :record="record"
          :initial-quota="initialCopilotQuota"
          :initial-quota-error="initialCopilotQuotaError"
          @completed="u => $emit('copilot-completed', u)"
        />
      </section>

      <section v-else-if="activeProvider === 'codex'" class="shrink-0">
        <CodexConfigPanel
          :mode="mode"
          :record="record"
          @imported="u => $emit('codex-imported', u)"
          @error="m => $emit('codex-error', m)"
        />
      </section>

      <section class="shrink-0">
        <p class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
          Disabled Models <span class="text-accent-cyan">({{ disabledIds.length }})</span>
        </p>
        <TagCombobox
          v-model="disabledIds"
          :items="availableModelItems"
          placeholder="Search models, or type an id to disable"
          empty-text="Type a model id and press Enter to disable it"
        />
        <p class="mt-1.5 text-[11px] text-gray-600">
          Disabled models are hidden from the catalog and cannot be routed to. Toggle a model card on the right, or remove an entry here.
        </p>
      </section>

      <!-- Feature-flag editor fills the remaining column height (so the rail
           always reaches the same bottom as the right pane), but never
           shrinks below 16rem — when the right pane is short, the flag list
           scrolls inside this minimum-height area instead of disappearing. -->
      <section class="flex min-h-[16rem] flex-1 flex-col gap-2">
        <p class="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
          Upstream Feature Flags <span class="text-accent-cyan">({{ Object.keys(flagOverrides).length }})</span>
        </p>
        <FlagOverridesEditor
          v-model="flagOverrides"
          :flags="flags"
          :provider-kind="activeProvider"
          name-prefix="upstream-flag"
          class="min-h-0 flex-1"
        />
      </section>

    </div>
  </aside>
</template>
