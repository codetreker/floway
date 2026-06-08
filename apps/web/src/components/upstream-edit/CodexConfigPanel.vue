<script setup lang="ts">
// Codex provider panel for the upstream-edit workbench. Drives the entire
// codex import flow — both create and re-import — so the page-level Save
// button stays out of the codex path (matching CopilotConfigPanel's
// device-flow ownership). Edit mode wraps the same import form in an
// account card + buttons row, and gates the form behind a "Re-import
// credential" toggle so the operator only sees the paste UI when they
// explicitly request it.

import { Button, Spinner } from '@floway-dev/ui';
import { computed, ref, watch } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { UpstreamRecord } from '../../api/types.ts';

import CodexAccountCard from './CodexAccountCard.vue';
import CodexImportTabs from './CodexImportTabs.vue';
import type { CodexImportTab, CodexPkceStartResult } from './codex-import-types.ts';

const props = defineProps<{
  mode: 'create' | 'edit';
  record: UpstreamRecord | null;
}>();

const emit = defineEmits<{
  // Bubbled up after a successful create / re-import / refresh-now. The
  // parent re-routes to /dashboard/upstreams/:id so the loader picks up
  // the freshly-rotated state.
  imported: [record: UpstreamRecord];
  error: [message: string];
}>();

const api = useApi();

const draft = ref<{ activeTab: CodexImportTab; authJsonText: string; callbackUrlText: string }>(
  { activeTab: 'auth_json', authJsonText: '', callbackUrlText: '' },
);
const submitting = ref(false);
const refreshing = ref(false);
// In edit mode the import form is collapsed by default — operators don't
// need the paste UI in their face every time they edit a codex row.
const reimportOpen = ref(false);

const pkce = ref<CodexPkceStartResult | null>(null);
const pkceLoading = ref(false);
const pkceError = ref<string | null>(null);

const fetchPkceStart = async () => {
  if (pkce.value || pkceLoading.value) return;
  pkceLoading.value = true;
  pkceError.value = null;
  const { data, error } = await callApi<CodexPkceStartResult>(
    () => api.api.upstreams['codex-pkce-start'].$post({ json: {} }),
  );
  pkceLoading.value = false;
  if (error) { pkceError.value = error.message; return; }
  pkce.value = data ?? null;
};

const importFormVisible = computed(() => props.mode === 'create' || reimportOpen.value);

// Lazy: fetch the PKCE handshake the first time the operator surfaces the
// callback tab while the import form is visible. fetchPkceStart short-circuits
// if a fetch is already in flight or done, so a rapid reimportOpen toggle is
// safely idempotent.
watch([importFormVisible, () => draft.value.activeTab], ([visible, tab]) => {
  if (visible && tab === 'callback') void fetchPkceStart();
}, { immediate: true });

const buildBody = (): { ok: true; value: { auth_json?: unknown; callback?: { callback_url: string } } } | { ok: false; error: string } => {
  if (draft.value.activeTab === 'auth_json') {
    const text = draft.value.authJsonText.trim();
    if (!text) return { ok: false, error: 'Paste the contents of ~/.codex/auth.json' };
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch (e) { return { ok: false, error: `auth.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }; }
    return { ok: true, value: { auth_json: parsed } };
  }
  const url = draft.value.callbackUrlText.trim();
  if (!url) return { ok: false, error: 'Paste the URL the browser was redirected to' };
  return { ok: true, value: { callback: { callback_url: url } } };
};

// Single submit entry point shared by create and re-import. The endpoint
// dispatch is the only meaningful difference: /codex-import for create
// (the server synthesizes a default name from the imported identity, like
// the copilot device flow does), /:id/codex-reimport for re-import.
const submit = async () => {
  const body = buildBody();
  if (!body.ok) { emit('error', body.error); return; }

  submitting.value = true;
  const result = props.mode === 'create'
    ? await callApi<UpstreamRecord>(
      () => api.api.upstreams['codex-import'].$post({ json: body.value }),
    )
    : await callApi<UpstreamRecord>(
      () => api.api.upstreams[':id']['codex-reimport'].$post({ param: { id: props.record!.id }, json: body.value }),
    );
  submitting.value = false;
  if (result.error) { emit('error', result.error.message); return; }
  if (result.data) emit('imported', result.data);
  // Reset draft + PKCE so a subsequent edit / re-open starts clean.
  draft.value = { activeTab: 'auth_json', authJsonText: '', callbackUrlText: '' };
  pkce.value = null;
  reimportOpen.value = false;
};

const refreshTokenNow = async () => {
  if (!props.record) return;
  refreshing.value = true;
  const { data, error } = await callApi<UpstreamRecord>(
    () => api.api.upstreams[':id']['codex-refresh-now'].$post({ param: { id: props.record!.id }, json: {} }),
  );
  refreshing.value = false;
  if (error) { emit('error', error.message); return; }
  if (data) emit('imported', data);
};
</script>

<template>
  <div class="space-y-4">
    <template v-if="mode === 'edit' && record">
      <CodexAccountCard :record="record" />
      <div class="flex flex-wrap items-center gap-2">
        <Button :loading="refreshing" @click="refreshTokenNow">
          <Spinner v-if="refreshing" class="size-3.5" />
          <i v-else class="i-lucide-refresh-cw size-3.5" />
          Refresh token now
        </Button>
        <Button variant="secondary" @click="reimportOpen = !reimportOpen">
          <i class="i-lucide-key-round size-3.5" />
          {{ reimportOpen ? 'Cancel re-import' : 'Re-import credential' }}
        </Button>
      </div>
    </template>

    <!-- One import form drives both flows; only the surrounding chrome and
         the submit button label differ. -->
    <template v-if="importFormVisible">
      <p v-if="mode === 'create'" class="text-xs text-gray-500">
        Codex credentials come from the official Codex CLI. Paste
        <code class="rounded bg-surface-700 px-1 py-0.5 text-[11px] text-gray-300">~/.codex/auth.json</code>
        from a logged-in workstation, or run the OAuth flow yourself and paste the
        URL the browser was redirected to.
      </p>
      <h4 v-else class="text-sm font-semibold text-white">Re-import credential</h4>
      <CodexImportTabs
        v-model:active-tab="draft.activeTab"
        v-model:auth-json-text="draft.authJsonText"
        v-model:callback-url-text="draft.callbackUrlText"
        :pkce="pkce"
        :pkce-loading="pkceLoading"
      />
      <p v-if="pkceError" class="text-xs text-accent-rose">{{ pkceError }}</p>
      <div class="flex justify-end">
        <Button :loading="submitting" @click="submit">
          <Spinner v-if="submitting" class="size-3.5" />
          {{ mode === 'create' ? 'Import' : 'Re-import' }}
        </Button>
      </div>
    </template>
  </div>
</template>
