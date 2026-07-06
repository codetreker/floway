import { onScopeDispose, ref, watch, type Ref } from 'vue';

import { authFetch } from '../api/client.ts';
import { useAuthStore } from '../stores/auth.ts';
import type { DumpMetadata } from '@floway-dev/gateway/dump-types';

// Rebuild the dedup set after this many ids to bound memory on long-lived subscriptions.
const DEDUP_REBUILD_THRESHOLD = 10_000;

// Matches the server's LIST_LIMIT_DEFAULT.
const OLDER_PAGE_LIMIT = 100;

interface DumpSubscription {
  records: Ref<DumpMetadata[]>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  loadOlder: () => Promise<void>;
}

interface SnapshotPayload {
  records: DumpMetadata[];
}

interface ServerErrorPayload {
  message: string;
}

interface ListResponse {
  records: DumpMetadata[];
}

export const useDumpSubscription = (keyId: Ref<string>): DumpSubscription => {
  const auth = useAuthStore();

  const records = ref<DumpMetadata[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const seen = new Set<string>();

  let source: EventSource | null = null;
  let currentKeyId = '';

  const rebuildSeen = () => {
    seen.clear();
    for (const r of records.value) seen.add(r.id);
  };

  const close = () => {
    if (source) {
      source.close();
      source = null;
    }
  };

  const reset = () => {
    close();
    records.value = [];
    seen.clear();
    error.value = null;
    loading.value = false;
    currentKeyId = '';
  };

  const handleSnapshot = (snapshot: DumpMetadata[]) => {
    // Preserve paged-in older history past the snapshot's tail. ULIDs sort
    // lexically by time, so anything with id strictly less than the snapshot's
    // oldest id is older than the snapshot.
    const snapshotIds = new Set(snapshot.map(r => r.id));
    const oldestSnapshotId = snapshot.length > 0 ? snapshot[snapshot.length - 1]!.id : null;
    const olderTail = oldestSnapshotId === null
      ? []
      : records.value.filter(r => !snapshotIds.has(r.id) && r.id < oldestSnapshotId);
    records.value = [...snapshot, ...olderTail];
    rebuildSeen();
    loading.value = false;
    error.value = null;
  };

  const handleAppended = (meta: DumpMetadata) => {
    if (seen.has(meta.id)) return;
    records.value = [meta, ...records.value];
    seen.add(meta.id);
    if (seen.size > DEDUP_REBUILD_THRESHOLD) rebuildSeen();
  };

  const open = (id: string) => {
    close();
    currentKeyId = id;
    loading.value = true;
    error.value = null;
    const token = auth.authToken;
    if (!token) {
      throw new Error('useDumpSubscription invoked without an authenticated session');
    }
    const url = `/api/dump/keys/${encodeURIComponent(id)}/stream?session=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    source = es;

    es.addEventListener('snapshot', ev => {
      const payload = JSON.parse((ev as MessageEvent).data) as SnapshotPayload;
      handleSnapshot(payload.records);
    });
    es.addEventListener('appended', ev => {
      const meta = JSON.parse((ev as MessageEvent).data) as DumpMetadata;
      handleAppended(meta);
    });
    es.addEventListener('error', rawEv => {
      const ev = rawEv as MessageEvent;
      // Server-sent `event: error` frames arrive here as MessageEvents with `data`;
      // native transport errors arrive on the same listener with empty data.
      if (typeof ev.data === 'string' && ev.data.length > 0) {
        let message = ev.data;
        try {
          const payload = JSON.parse(ev.data) as ServerErrorPayload;
          message = payload.message;
        } catch {
        }
        error.value = message;
        loading.value = false;
        // Terminal: stop the EventSource so the browser doesn't auto-reconnect.
        close();
        return;
      }
      if (es.readyState === EventSource.CLOSED) {
        error.value = 'Stream disconnected';
        loading.value = false;
      }
    });
  };

  const loadOlder = async () => {
    if (currentKeyId === '') return;
    const oldest = records.value[records.value.length - 1];
    if (!oldest) return;
    const url = `/api/dump/keys/${encodeURIComponent(currentKeyId)}/records`
      + `?before=${encodeURIComponent(oldest.id)}&limit=${OLDER_PAGE_LIMIT}`;
    const res = await authFetch(url);
    if (!res.ok) {
      error.value = `Failed to load older records: HTTP ${res.status}`;
      return;
    }
    const body = (await res.json()) as ListResponse;
    if (body.records.length === 0) return;
    const fresh = body.records.filter(r => !seen.has(r.id));
    if (fresh.length === 0) return;
    records.value = [...records.value, ...fresh];
    for (const r of fresh) seen.add(r.id);
  };

  watch(keyId, id => {
    if (id === '') {
      reset();
      return;
    }
    reset();
    open(id);
  }, { immediate: true });

  onScopeDispose(() => {
    close();
  });

  return { records, loading, error, loadOlder };
};
