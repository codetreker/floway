<script setup lang="ts">
// Custom provider-specific fields (Base URL, auth, default endpoints, fetch
// /models toggle, path overrides). The model list is owned by ModelsPanel on
// the right side — this panel only carries the connection-shaped config.

import { Button, Input, Switch } from '@floway-dev/ui';

import type { CustomDraft } from './customConfig.ts';
import { PATH_KEYS } from './customConfig.ts';
import EndpointsField from './EndpointsField.vue';
import SecretInput from '../shared/SecretInput.vue';

const draft = defineModel<CustomDraft>({ required: true });

defineProps<{
  bearerTokenSet: boolean;
  editMode: boolean;
  fetchLoading: boolean;
  fetchError: string | null;
  // Wall-clock summary of the last fetch (e.g. "12 returned · 3m ago"), or null
  // when no successful fetch has happened yet.
  fetchStatus: string | null;
}>();

const emit = defineEmits<{ 'fetch-models': [] }>();
</script>

<template>
  <div class="space-y-5">
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
        <label class="mb-1.5 block text-xs font-medium text-gray-500">
          {{ draft.authStyle === 'anthropic' ? 'API Key' : 'Bearer Token' }}<span v-if="editMode && bearerTokenSet" class="text-gray-500"> (leave blank to keep)</span>
        </label>
        <SecretInput
          :model-value="draft.bearerToken"
          :placeholder="bearerTokenSet ? '••••••••' : (draft.authStyle === 'anthropic' ? 'sk-ant-xxxxx' : 'sk-xxxxx')"
          class="font-mono"
          @update:model-value="v => draft = { ...draft, bearerToken: v }"
        />
      </div>
    </div>

    <div>
      <p class="mb-2 text-xs font-medium text-gray-500">Auth Style</p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label
          class="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-xs text-gray-300 transition-colors"
          :class="draft.authStyle === 'bearer'
            ? 'border-accent-cyan/40 bg-accent-cyan/5'
            : 'border-white/10 bg-surface-800/50 hover:border-white/20'"
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
          class="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-xs text-gray-300 transition-colors"
          :class="draft.authStyle === 'anthropic'
            ? 'border-accent-cyan/40 bg-accent-cyan/5'
            : 'border-white/10 bg-surface-800/50 hover:border-white/20'"
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
      <p class="mb-2 text-xs font-medium text-gray-500">Default LLM Endpoints</p>
      <EndpointsField
        :model-value="draft.endpoints"
        kind="chat"
        @update:model-value="v => draft = { ...draft, endpoints: v }"
      />
      <p class="mt-1.5 text-[11px] text-gray-600">Chat models auto-discovered from <code class="font-mono">/models</code> inherit this set; manual rows pick their own.</p>
    </div>

    <div>
      <div class="mb-2 flex items-baseline justify-between gap-3">
        <p class="text-xs font-medium text-gray-500">Fetch <code class="font-mono">/models</code></p>
        <p v-if="fetchStatus" class="text-[11px] text-gray-500">{{ fetchStatus }}</p>
      </div>
      <div class="flex items-center gap-2">
        <Switch
          :model-value="draft.modelsFetch.enabled"
          @update:model-value="v => draft = { ...draft, modelsFetch: { ...draft.modelsFetch, enabled: !!v } }"
        />
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
          :loading="fetchLoading"
          :disabled="!draft.modelsFetch.enabled || fetchLoading"
          @click="emit('fetch-models')"
        >Fetch</Button>
      </div>
      <p v-if="fetchError" class="mt-1.5 text-[11px] text-accent-rose">{{ fetchError }}</p>
      <p v-else-if="!draft.modelsFetch.enabled" class="mt-1.5 text-[11px] text-accent-amber">
        Fetch disabled — auto models are hidden and dropped on save. Only manual rows persist.
      </p>
    </div>

    <div>
      <p class="mb-2 text-xs font-medium text-gray-500">Path Overrides</p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label v-for="key in PATH_KEYS" :key="key" class="min-w-0">
          <span class="mb-1 block truncate font-mono text-[10px] text-gray-500">{{ key }}</span>
          <Input
            :model-value="draft.pathOverrides[key]"
            :placeholder="`/v1/${key.replace('_', '/')}`"
            size="sm"
            class="font-mono"
            @update:model-value="v => draft = { ...draft, pathOverrides: { ...draft.pathOverrides, [key]: v } }"
          />
        </label>
      </div>
      <p class="mt-2 text-[11px] text-gray-600">
        Leave blank to use the default <code class="font-mono">/v1/&lt;endpoint&gt;</code>. Count-tokens follows the messages path.
      </p>
    </div>
  </div>
</template>
