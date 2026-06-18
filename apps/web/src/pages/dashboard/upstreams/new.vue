<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';
import { useRoute } from 'vue-router';

import type { UpstreamProviderKind } from '../../../api/types.ts';
import UpstreamEditPage from '../../../components/upstream-edit/UpstreamEditPage.vue';
import { useProxiesStore } from '../../../composables/useProxies.ts';
import { useRuntimeInfo } from '../../../composables/useRuntimeInfo.ts';
import { useUpstreamsStore } from '../../../composables/useUpstreams.ts';

export const useNewUpstreamData = defineBasicLoader(async () => {
  const store = useUpstreamsStore();
  await Promise.all([store.load(), useProxiesStore().load(), useRuntimeInfo().load()]);
  const list = store.upstreams.value ?? [];
  const nextSortOrder = list.reduce((acc, u) => Math.max(acc, u.sort_order), -1) + 1;
  return {
    flags: store.flagCatalog.value ?? [],
    nextSortOrder,
  };
});
</script>

<script setup lang="ts">
definePage({ meta: { requiresAdmin: true } });

const route = useRoute('/dashboard/upstreams/new');
const data = useNewUpstreamData();
const store = useUpstreamsStore();

const initialProvider: UpstreamProviderKind = (() => {
  const q = route.query.provider;
  if (q === 'azure' || q === 'copilot' || q === 'codex' || q === 'custom') return q;
  return 'custom';
})();

const onSaved = async () => {
  // Refetch so navigations back to listings see the new upstream.
  await store.load();
};
</script>

<template>
  <UpstreamEditPage
    mode="create"
    :record="null"
    :initial-provider="initialProvider"
    :next-sort-order="data.data.value.nextSortOrder"
    :flags="data.data.value.flags"
    @saved="onSaved"
  />
</template>
