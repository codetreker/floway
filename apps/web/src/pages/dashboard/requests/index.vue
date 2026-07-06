<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';
import { onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';

import { callApi, useApi } from '../../../api/client.ts';
import type { ApiKey } from '../../../api/types.ts';

export const useRequestsIndexData = defineBasicLoader(async () => {
  const api = useApi();
  const keysRes = await callApi<ApiKey[]>(() => api.api.keys.$get());
  if (keysRes.error) {
    return { firstDumpKeyId: null as string | null, error: keysRes.error.message };
  }
  const firstDumpKey = keysRes.data.find(k => k.dump_retention_seconds !== null);
  return { firstDumpKeyId: firstDumpKey?.id ?? null, error: null as string | null };
});
</script>

<script setup lang="ts">
const router = useRouter();
const data = useRequestsIndexData();

const redirectIfPossible = (firstId: string | null) => {
  if (firstId !== null) void router.replace(`/dashboard/requests/${firstId}`);
};

onMounted(() => { redirectIfPossible(data.data.value.firstDumpKeyId); });
watch(() => data.data.value.firstDumpKeyId, redirectIfPossible);
</script>

<template>
  <div>
    <div v-if="data.data.value.error" class="mb-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
      {{ data.data.value.error }}
    </div>

    <div v-else-if="data.data.value.firstDumpKeyId === null" class="glass-card animate-in mx-auto max-w-md px-6 py-10 text-center text-sm text-gray-400">
      <p class="mb-3 text-gray-300">No API key has dump retention enabled.</p>
      <p class="mb-4 text-xs text-gray-500">Enable retention on a key to start capturing its requests.</p>
      <RouterLink to="/dashboard/keys" class="text-accent-cyan hover:underline">
        Go to API Keys →
      </RouterLink>
    </div>

    <div v-else class="grid place-items-center py-12 text-sm text-gray-500">Redirecting…</div>
  </div>
</template>
