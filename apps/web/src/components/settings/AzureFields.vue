<script setup lang="ts">
import { Input } from '@floway-dev/ui';

import type { FlagDef, UpstreamModelConfig } from '../../api/types.ts';

import SecretInput from '../shared/SecretInput.vue';

import ModelListField from './ModelListField.vue';

// Azure deployments are always hand-configured — there is no live /models
// browse — so every row is manual and the field runs in allManual mode.
interface AzureDraft {
  endpoint: string;
  apiKey: string;
  models: UpstreamModelConfig[];
}

const draft = defineModel<AzureDraft>({ required: true });

defineProps<{
  apiKeySet: boolean;
  flags: FlagDef[];
  upstreamFlagOverrides: Record<string, boolean>;
}>();
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div>
        <label class="mb-1.5 block text-xs font-medium text-gray-500">Endpoint</label>
        <Input
          :model-value="draft.endpoint"
          placeholder="e.g. https://resource.openai.azure.com/openai/v1"
          class="font-mono"
          @update:model-value="v => draft = { ...draft, endpoint: v }"
        />
      </div>
      <div>
        <label class="mb-1.5 block text-xs font-medium text-gray-500">
          {{ apiKeySet ? 'API Key (leave blank to keep)' : 'API Key' }}
        </label>
        <SecretInput
          :model-value="draft.apiKey"
          :placeholder="apiKeySet ? '••••••••' : 'xxxxx'"
          class="font-mono"
          @update:model-value="v => draft = { ...draft, apiKey: v }"
        />
      </div>
    </div>

    <ModelListField
      v-model="draft.models"
      :all-manual="true"
      upstream-id-label="Deployment"
      flag-provider-kind="azure"
      :flags="flags"
      :upstream-flag-overrides="upstreamFlagOverrides"
    />
  </div>
</template>
