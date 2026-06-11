import { computed, ref, shallowRef } from 'vue';

import { callApi, useApi } from '../api/client.ts';
import type { BackoffRow, ProxyRecord } from '../api/types.ts';

// Module-scoped cache so concurrent callers share one fetch instead of
// re-fetching per mount.
const proxies = shallowRef<ProxyRecord[] | null>(null);
const backoffs = shallowRef<BackoffRow[] | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

// Group `backoffs` by `proxy_id` once so consumers read a
// (proxy_id → rows[]) Map instead of re-folding the array per render.
const backoffsByProxyId = computed<Map<string, BackoffRow[]>>(() => {
  const map = new Map<string, BackoffRow[]>();
  for (const row of backoffs.value ?? []) {
    const list = map.get(row.proxy_id);
    if (list) list.push(row);
    else map.set(row.proxy_id, [row]);
  }
  return map;
});

export const useProxiesStore = () => {
  const api = useApi();

  const load = async () => {
    loading.value = true;
    error.value = null;
    const [listRes, backoffsRes] = await Promise.all([
      callApi<ProxyRecord[]>(() => api.api.proxies.$get()),
      callApi<BackoffRow[]>(() => api.api.proxies.backoffs.$get()),
    ]);
    if (listRes.error) error.value = listRes.error.message;
    else if (listRes.data) proxies.value = [...listRes.data].sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (backoffsRes.error && !error.value) error.value = backoffsRes.error.message;
    else if (backoffsRes.data) backoffs.value = backoffsRes.data;
    loading.value = false;
  };

  return { proxies, backoffsByProxyId, loading, error, load };
};
