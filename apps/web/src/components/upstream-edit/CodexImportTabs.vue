<script setup lang="ts">
// Tabbed paste-area for both creation and re-import flows. auth_json: paste
// ~/.codex/auth.json verbatim. callback: open the PKCE authorize URL in a
// browser, then paste the redirected URL. The parent owns PKCE-start + the
// v-model values so flushing/closing belong with the outer panel.

import { Button, Spinner, Tabs, Textarea } from '@floway-dev/ui';

import type { CodexImportTab, CodexPkceStartResult } from './codex-import-types.ts';

const props = defineProps<{
  pkce: CodexPkceStartResult | null;
  pkceLoading: boolean;
}>();

const activeTab = defineModel<CodexImportTab>('activeTab', { required: true });
const authJsonText = defineModel<string>('authJsonText', { required: true });
const callbackUrlText = defineModel<string>('callbackUrlText', { required: true });

const importTabs = [
  { value: 'auth_json', label: 'Paste auth.json' },
  { value: 'callback', label: 'Paste login URL' },
] as const;

const copyAuthorizeUrl = async () => {
  if (!props.pkce) return;
  try { await navigator.clipboard.writeText(props.pkce.authorize_url); }
  catch { /* clipboard is best-effort; the visible link still works */ }
};
</script>

<template>
  <Tabs v-model="activeTab" :tabs="[...importTabs]">
    <template #auth_json>
      <div class="space-y-3">
        <p class="text-xs text-gray-500">
          Paste the contents of <code class="rounded bg-surface-700 px-1 py-0.5 text-[11px] text-gray-300">~/.codex/auth.json</code>
          after signing in with the Codex CLI. The gateway keeps only the OAuth refresh token + identity fields.
        </p>
        <Textarea
          v-model="authJsonText"
          :rows="10"
          monospace
          placeholder='{"OPENAI_API_KEY": null, "tokens": { ... }, "last_refresh": "..." }'
        />
      </div>
    </template>

    <template #callback>
      <div class="space-y-3">
        <p class="text-xs text-gray-500">
          Open the authorize URL in a browser signed in to ChatGPT, complete the consent screen,
          then paste the URL the browser was redirected to (it starts with
          <code class="rounded bg-surface-700 px-1 py-0.5 text-[11px] text-gray-300">http://localhost:1455/auth/callback</code>).
        </p>

        <div v-if="pkceLoading" class="flex items-center gap-2 text-sm text-gray-400">
          <Spinner class="size-4" /> Preparing PKCE flow…
        </div>

        <div v-else-if="pkce" class="space-y-2">
          <p class="text-xs font-medium text-gray-500">Authorize URL</p>
          <a :href="pkce.authorize_url" target="_blank" rel="noopener" class="block break-all text-xs text-accent-cyan hover:underline">
            {{ pkce.authorize_url }}
          </a>
          <div class="flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
            <Button size="sm" variant="secondary" @click="copyAuthorizeUrl">
              <i class="i-lucide-clipboard size-3.5" /> Copy URL
            </Button>
            <span>Expires in {{ Math.round(pkce.expires_in_seconds / 60) }} min</span>
          </div>
        </div>

        <Textarea
          v-model="callbackUrlText"
          :rows="3"
          monospace
          placeholder="http://localhost:1455/auth/callback?code=...&state=..."
        />
      </div>
    </template>
  </Tabs>
</template>
