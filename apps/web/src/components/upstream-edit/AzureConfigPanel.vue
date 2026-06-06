<script setup lang="ts">
// Azure provider-specific fields. Deployments are always manual (no live
// /models browse) — the model list itself lives in ModelsPanel on the right.

import { Input } from '@floway-dev/ui';

import type { AzureDraft } from './customConfig.ts';
import SecretInput from '../shared/SecretInput.vue';

const draft = defineModel<AzureDraft>({ required: true });

defineProps<{
  apiKeySet: boolean;
  editMode: boolean;
}>();
</script>

<template>
  <div class="space-y-5">
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
        API Key<span v-if="editMode && apiKeySet" class="text-gray-500"> (leave blank to keep)</span>
      </label>
      <SecretInput
        :model-value="draft.apiKey"
        :placeholder="apiKeySet ? '••••••••' : 'xxxxx'"
        class="font-mono"
        @update:model-value="v => draft = { ...draft, apiKey: v }"
      />
    </div>
  </div>
</template>
