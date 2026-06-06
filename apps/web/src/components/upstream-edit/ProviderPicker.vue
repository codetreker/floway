<script setup lang="ts">
import type { UpstreamProviderKind } from '../../api/types.ts';
import ProviderCard from './ProviderCard.vue';

const active = defineModel<UpstreamProviderKind>({ required: true });
</script>

<template>
  <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
    <ProviderCard
      tone="amber"
      title="Custom"
      subtitle="OpenAI-compatible bearer"
      :selected="active === 'custom'"
      @select="active = 'custom'"
    >
      <template #icon>
        <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </template>
    </ProviderCard>
    <ProviderCard
      tone="emerald"
      title="Azure"
      subtitle="Azure OpenAI / Foundry"
      :selected="active === 'azure'"
      @select="active = 'azure'"
    >
      <template #icon>
        <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        </svg>
      </template>
    </ProviderCard>
    <ProviderCard
      tone="cyan"
      title="Copilot"
      subtitle="GitHub Copilot account"
      :selected="active === 'copilot'"
      @select="active = 'copilot'"
    >
      <template #icon>
        <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
        </svg>
      </template>
    </ProviderCard>
  </div>
</template>
