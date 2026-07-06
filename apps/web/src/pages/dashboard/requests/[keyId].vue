<script lang="ts">
import { useEventListener } from '@vueuse/core';
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { callApi, useApi } from '../../../api/client.ts';
import type { ApiKey } from '../../../api/types.ts';
import RecordDetail from '../../../components/dump/RecordDetail.vue';
import RequestList from '../../../components/dump/RequestList.vue';
import { useDumpSubscription } from '../../../composables/useDumpSubscription.ts';
import { useHashRef } from '../../../composables/useHashRef.ts';

export const useRequestsPageData = defineBasicLoader(async () => {
  const api = useApi();
  const keysRes = await callApi<ApiKey[]>(() => api.api.keys.$get());
  if (keysRes.error) {
    // Distinguish "failed to load keys" from "no dump-enabled keys" — the
    // empty-list branch must not absorb load failures.
    return { keys: null as ApiKey[] | null, error: keysRes.error.message };
  }
  return { keys: keysRes.data, error: null as string | null };
});
</script>

<script setup lang="ts">
const api = useApi();
const route = useRoute('/dashboard/requests/[keyId]');
const router = useRouter();
const initialData = useRequestsPageData();

const keys = ref<ApiKey[] | null>(initialData.data.value.keys);
const loadError = ref<string | null>(initialData.data.value.error);

const dumpKeys = computed(() => keys.value === null ? null : keys.value.filter(k => k.dump_retention_seconds !== null));

const selectedKeyId = computed(() => route.params.keyId);
const selectedRecordId = useHashRef();

const subscription = useDumpSubscription(selectedKeyId);

const selectKey = (id: string) => {
  if (id === selectedKeyId.value) return;
  // Record ids are scoped to one key — carrying the hash across keys would
  // render as "Record not found".
  selectedRecordId.value = null;
  void router.replace({ path: `/dashboard/requests/${id}` });
};

const reloadKeys = async () => {
  const res = await callApi<ApiKey[]>(() => api.api.keys.$get());
  if (res.error) {
    loadError.value = res.error.message;
    return;
  }
  keys.value = res.data;
  loadError.value = null;
};

useEventListener(window, 'focus', () => { void reloadKeys(); });

const keyNotFound = computed(() => dumpKeys.value !== null && !dumpKeys.value.some(k => k.id === selectedKeyId.value));
</script>

<template>
  <div>
    <div v-if="loadError" class="mb-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
      {{ loadError }}
    </div>

    <div v-if="keyNotFound" class="glass-card animate-in mx-auto max-w-md px-6 py-10 text-center text-sm text-gray-400">
      <p class="mb-3 text-gray-300">This key does not exist or no longer has dump retention enabled.</p>
      <RouterLink to="/dashboard/requests" class="text-accent-cyan hover:underline">
        Pick another key →
      </RouterLink>
    </div>

    <div v-else class="glass-card animate-in flex h-[calc(100dvh-130px)] min-h-[560px] flex-col overflow-hidden lg:h-[calc(100vh-140px)] lg:flex-row">
      <aside class="flex max-h-72 w-full min-h-0 shrink-0 flex-col border-b border-white/[0.06] lg:max-h-none lg:w-90 lg:border-b-0 lg:border-r">
        <div class="border-b border-white/[0.06] p-3">
          <select
            v-if="dumpKeys && dumpKeys.length > 0"
            :value="selectedKeyId"
            class="w-full bg-transparent text-xs text-gray-200 focus:outline-none"
            @change="selectKey(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="k in dumpKeys" :key="k.id" :value="k.id">
              {{ k.name }} ({{ k.key.slice(-4) }})
            </option>
          </select>
          <p v-else-if="dumpKeys" class="text-xs text-gray-500">No dump-enabled keys.</p>
        </div>

        <div v-if="dumpKeys && dumpKeys.length === 0" class="px-4 py-6 text-center text-xs text-gray-500">
          Enable request dump retention on an API key to start capturing requests.
          <RouterLink to="/dashboard/keys" class="mt-2 block text-accent-cyan hover:underline">
            Go to API Keys →
          </RouterLink>
        </div>

        <div v-else-if="dumpKeys" class="flex min-h-0 flex-1 flex-col">
          <RequestList
            :records="subscription.records.value"
            :loading="subscription.loading.value"
            :error="subscription.error.value"
            v-model:selected-id="selectedRecordId"
            @load-older="subscription.loadOlder"
          />
        </div>
      </aside>

      <div class="flex min-w-0 min-h-0 flex-1 flex-col">
        <RecordDetail :key-id="selectedKeyId" :record-id="selectedRecordId" />
      </div>
    </div>
  </div>
</template>
