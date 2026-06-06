<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';

import { useUpstreamsStore as useStoreForLoader } from '../../../composables/useUpstreams.ts';

export const useNewUpstreamData = defineBasicLoader(async () => {
  const store = useStoreForLoader();
  await store.load();
  const list = store.upstreams.value ?? [];
  const nextSortOrder = list.reduce((acc, u) => Math.max(acc, u.sort_order), -1) + 1;
  return {
    flags: store.flagCatalog.value ?? [],
    nextSortOrder,
  };
});
</script>

<script setup lang="ts">
import { useRoute } from 'vue-router';

import UpstreamEditPage from '../../../components/upstream-edit/UpstreamEditPage.vue';
import { useUpstreamsStore } from '../../../composables/useUpstreams.ts';
import type { UpstreamProviderKind } from '../../../api/types.ts';

definePage({ meta: { requiresAdmin: true } });

const route = useRoute('/dashboard/upstreams/new');
const data = useNewUpstreamData();
const store = useUpstreamsStore();

const initialProvider: UpstreamProviderKind = (() => {
  const q = route.query.provider;
  if (q === 'azure' || q === 'copilot' || q === 'custom') return q;
  return 'custom';
})();

const onSaved = async () => {
  // Refetch the list so the settings page sees the new upstream when the
  // editor navigates back. The Copilot device-flow path is the one
  // exception that ends on the new upstream's edit page (see
  // UpstreamEditPage.onCopilotCompleted), so the just-authorised account
  // can be configured straight away without a round-trip through settings.
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
