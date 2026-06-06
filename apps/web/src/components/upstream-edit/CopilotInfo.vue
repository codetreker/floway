<script setup lang="ts">
import { Card } from '@floway-dev/ui';
import { computed, ref } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { CopilotQuotaSnapshot, CopilotUpstreamConfig } from '../../api/types.ts';

const props = defineProps<{
  upstreamId: string;
  config: CopilotUpstreamConfig;
  initialQuota?: CopilotQuotaSnapshot | null;
  initialQuotaError?: string | null;
}>();

const api = useApi();
const quota = ref<CopilotQuotaSnapshot | null>(props.initialQuota ?? null);
const quotaError = ref<string | null>(props.initialQuotaError ?? null);
const loadingQuota = ref(false);

const loadQuota = async () => {
  loadingQuota.value = true;
  quotaError.value = null;
  const { data, error } = await callApi<CopilotQuotaSnapshot>(
    () => api.api.upstreams[':id'].copilot.quota.$get({ param: { id: props.upstreamId } }),
  );
  loadingQuota.value = false;
  if (error) {
    quotaError.value = error.message;
    return;
  }
  quota.value = data ?? null;
};

const premium = computed(() => quota.value?.quota_snapshots?.premium_interactions);

const usedPercent = computed(() => {
  const p = premium.value;
  if (!p || p.entitlement <= 0) return null;
  const used = Math.max(0, p.entitlement - p.remaining);
  return Math.min(100, Math.round((used / p.entitlement) * 100));
});
</script>

<template>
  <div class="space-y-4">
    <Card :padded="false" class="space-y-3 p-4">
      <div class="flex items-center gap-3">
        <img
          v-if="config.user.avatar_url"
          :src="config.user.avatar_url"
          :alt="config.user.login"
          class="size-10 rounded-full"
        >
        <div>
          <p class="text-sm font-medium text-white">{{ config.user.name ?? config.user.login }}</p>
          <p class="text-xs text-gray-400">@{{ config.user.login }} · {{ config.accountType }}</p>
        </div>
      </div>
    </Card>

    <Card :padded="false" class="space-y-3 p-4">
      <header class="flex items-center justify-between">
        <h4 class="text-sm font-semibold text-white">Premium quota</h4>
        <button
          type="button"
          class="text-xs text-accent-cyan hover:text-accent-cyan"
          :disabled="loadingQuota"
          @click="loadQuota"
        >
          {{ loadingQuota ? 'Loading…' : 'Refresh' }}
        </button>
      </header>
      <div v-if="quotaError" class="text-xs text-accent-rose">{{ quotaError }}</div>
      <template v-else-if="premium">
        <div class="space-y-1.5">
          <div class="flex items-baseline justify-between text-sm">
            <span class="text-white">{{ premium.entitlement - premium.remaining }} / {{ premium.entitlement }}</span>
            <span class="text-xs text-gray-400">{{ usedPercent }}% used</span>
          </div>
          <div class="h-1.5 overflow-hidden rounded-full bg-surface-700">
            <div
              class="h-full bg-accent-cyan transition-[width]"
              :style="{ width: `${usedPercent ?? 0}%` }"
            />
          </div>
          <p v-if="premium.reset_date" class="text-xs text-gray-500">
            Resets on {{ new Date(premium.reset_date).toLocaleDateString() }}
          </p>
        </div>
      </template>
      <p v-else-if="!loadingQuota" class="text-xs text-gray-500">No premium quota reported.</p>
    </Card>
  </div>
</template>
