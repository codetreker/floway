<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';
import { ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { callApi, useApi } from '../../api/client.ts';
import type { ProxyRecord, SearchConfig, UpstreamRecord } from '../../api/types.ts';
import ProxyEditDialog from '../../components/proxy-edit/ProxyEditDialog.vue';
import ApiEndpointsSection from '../../components/settings/ApiEndpointsSection.vue';
import ExportSection from '../../components/settings/ExportSection.vue';
import ImportSection from '../../components/settings/ImportSection.vue';
import ProxiesSettingsCard from '../../components/settings/ProxiesSettingsCard.vue';
import SearchConfigSection from '../../components/settings/SearchConfigSection.vue';
import UpstreamsSettingsCard from '../../components/settings/UpstreamsSettingsCard.vue';
import { useModelsStore } from '../../composables/useModels.ts';
import { useProxiesStore } from '../../composables/useProxies.ts';
import { useUpstreamsStore } from '../../composables/useUpstreams.ts';

const defaultSearchConfig: SearchConfig = {
  provider: 'disabled',
  tavily: { apiKey: '' },
  microsoftGrounding: { apiKey: '' },
};

export const useSettingsPageData = defineBasicLoader(async () => {
  const api = useApi();
  const [searchRes] = await Promise.all([
    callApi<SearchConfig>(() => api.api['search-config'].$get()),
    useUpstreamsStore().load(),
    useModelsStore().load(),
    useProxiesStore().load(),
  ]);
  return {
    searchConfig: searchRes.data ?? defaultSearchConfig,
    searchConfigError: searchRes.error?.message ?? null,
  };
});
</script>

<script setup lang="ts">

definePage({ meta: { requiresAdmin: true } });

const router = useRouter();
const { upstreams, loading: storeLoading, error: storeError, load } = useUpstreamsStore();
const modelsStore = useModelsStore();
const proxiesStore = useProxiesStore();
const { load: loadProxies } = proxiesStore;
const settingsData = useSettingsPageData();

// Local working copy the child reorders via v-model:ordered; reloadAll
// re-syncs from the store after the child reports a change.
const ordered = ref<UpstreamRecord[]>([]);
watch(upstreams, list => {
  ordered.value = list ? [...list] : [];
}, { immediate: true });

const reloadAll = async () => {
  await Promise.all([load(), modelsStore.load(), loadProxies()]);
};

// Proxy editor is hosted as a modal — v-if drives the unmount on close
// so the next open boots from a fresh script setup (no manual reset).
const proxyDialogOpen = ref(false);
const proxyDialogRecord = ref<ProxyRecord | null>(null);
const openProxyDialog = (record: ProxyRecord | null): void => {
  proxyDialogRecord.value = record;
  proxyDialogOpen.value = true;
};
</script>

<template>
  <div>
    <div v-if="storeError" class="mb-4 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
      {{ storeError }}
    </div>

    <div class="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <div class="flex flex-col gap-5">
        <UpstreamsSettingsCard
          v-model:ordered="ordered"
          :loading="storeLoading"
          :models="modelsStore.models.value"
          @add="() => router.push('/dashboard/upstreams/new')"
          @edit="(record: UpstreamRecord) => router.push(`/dashboard/upstreams/${record.id}`)"
          @changed="reloadAll"
        />
        <ProxiesSettingsCard
          @add="() => openProxyDialog(null)"
          @edit="(record: ProxyRecord) => openProxyDialog(record)"
          @changed="reloadAll"
        />
        <SearchConfigSection
          :initial-config="settingsData.data.value.searchConfig"
          :initial-error="settingsData.data.value.searchConfigError"
        />
      </div>

      <div class="flex flex-col gap-5">
        <ApiEndpointsSection />
        <div class="glass-card p-5 sm:p-6 animate-in delay-2">
          <ExportSection :framed="false" />
          <div class="my-6 border-t border-white/[0.06]" />
          <ImportSection :framed="false" />
        </div>
      </div>
    </div>

    <ProxyEditDialog
      v-if="proxyDialogOpen"
      v-model:open="proxyDialogOpen"
      :record="proxyDialogRecord"
      @saved="reloadAll"
    />
  </div>
</template>
