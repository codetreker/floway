<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';

import { callApi, useApi } from '../../../api/client.ts';
import type { CopilotQuotaSnapshot, CustomRawModel, CustomUpstreamConfig, UpstreamModelConfig } from '../../../api/types.ts';
import { useUpstreamsStore } from '../../../composables/useUpstreams.ts';

// Pre-fetch the provider-specific model list (and Copilot's premium quota)
// during route resolution so the editor mounts with its right pane and
// account card already populated. Without this the page would render with
// empty bodies for a frame and then flicker once the onMount fetches
// resolved.
export const useEditUpstreamData = defineBasicLoader('/dashboard/upstreams/[id]', async route => {
  const api = useApi();
  const store = useUpstreamsStore();
  await store.load();
  const list = store.upstreams.value ?? [];
  const id = route.params.id;
  const record = list.find(u => u.id === id) ?? null;

  let copilotModels: UpstreamModelConfig[] = [];
  let copilotModelsError: string | null = null;
  let copilotQuota: CopilotQuotaSnapshot | null = null;
  let copilotQuotaError: string | null = null;
  let customRawModels: CustomRawModel[] = [];
  let customRawModelsError: string | null = null;
  let customFetchedAt: number | null = null;

  if (record?.provider === 'copilot') {
    const [modelsRes, quotaRes] = await Promise.all([
      callApi<{ data: UpstreamModelConfig[] }>(
        () => api.api.upstreams[':id'].models.$get({ param: { id: record.id } }),
      ),
      callApi<CopilotQuotaSnapshot>(
        () => api.api.upstreams[':id'].copilot.quota.$get({ param: { id: record.id } }),
      ),
    ]);
    if (modelsRes.error) copilotModelsError = modelsRes.error.message;
    else copilotModels = modelsRes.data?.data ?? [];
    if (quotaRes.error) copilotQuotaError = quotaRes.error.message;
    else copilotQuota = quotaRes.data ?? null;
  } else if (record?.provider === 'custom') {
    const cfg = record.config as CustomUpstreamConfig;
    if (cfg.modelsFetch?.enabled) {
      const { data, error } = await callApi<{ data: CustomRawModel[] }>(
        () => api.api.upstreams['fetch-models'].$post({
          json: {
            id: record.id,
            // The backend reuses the stored secret when `id` is present, so
            // the rest is just the saved config minus the bearerTokenSet
            // metadata flag.
            config: {
              baseUrl: cfg.baseUrl,
              authStyle: cfg.authStyle,
              endpoints: cfg.endpoints,
              modelsFetch: cfg.modelsFetch,
              models: cfg.models,
            },
          },
        }),
      );
      if (error) {
        customRawModelsError = error.message;
      } else {
        customRawModels = data?.data ?? [];
        customFetchedAt = Date.now();
      }
    }
  }

  return {
    record,
    flags: store.flagCatalog.value ?? [],
    nextSortOrder: list.reduce((acc, u) => Math.max(acc, u.sort_order), -1) + 1,
    copilotModels,
    copilotModelsError,
    copilotQuota,
    copilotQuotaError,
    customRawModels,
    customRawModelsError,
    customFetchedAt,
  };
});
</script>

<script setup lang="ts">
import { useRouter } from 'vue-router';

import UpstreamEditPage from '../../../components/upstream-edit/UpstreamEditPage.vue';

definePage({ meta: { requiresAdmin: true } });

const data = useEditUpstreamData();
const router = useRouter();
const store = useUpstreamsStore();

// Missing id → upstream was deleted; bounce back to settings. The list was
// already fetched by the loader, so a missing id is authoritative.
if (data.data.value.record === null) {
  void router.replace('/dashboard/settings');
}
</script>

<template>
  <UpstreamEditPage
    v-if="data.data.value.record"
    :key="data.data.value.record.id"
    mode="edit"
    :record="data.data.value.record"
    :next-sort-order="data.data.value.nextSortOrder"
    :flags="data.data.value.flags"
    :initial-copilot-models="data.data.value.copilotModels"
    :initial-copilot-models-error="data.data.value.copilotModelsError"
    :initial-copilot-quota="data.data.value.copilotQuota"
    :initial-copilot-quota-error="data.data.value.copilotQuotaError"
    :initial-custom-raw-models="data.data.value.customRawModels"
    :initial-custom-raw-models-error="data.data.value.customRawModelsError"
    :initial-custom-fetched-at="data.data.value.customFetchedAt"
    @saved="store.load"
  />
</template>
