<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';

import type { ClaudeCodeAuthorizeUrlResult } from './claude-code-import-types.ts';
import { Button, Spinner, Textarea } from '@floway-dev/ui';

defineProps<{
  pkce: ClaudeCodeAuthorizeUrlResult | null;
  pkceLoading: boolean;
  pkceError: string | null;
  placeholder: string;
}>();

const callbackUrlText = defineModel<string>('callbackUrlText', { required: true });

type CopyState = { kind: 'idle' } | { kind: 'copied' } | { kind: 'failed'; message: string };

const status = ref<CopyState>({ kind: 'idle' });
let resetTimer: ReturnType<typeof setTimeout> | undefined;
const copy = async (url: string) => {
  if (resetTimer !== undefined) clearTimeout(resetTimer);
  try {
    await navigator.clipboard.writeText(url);
    status.value = { kind: 'copied' };
    resetTimer = setTimeout(() => { status.value = { kind: 'idle' }; }, 2000);
  } catch (e) {
    status.value = { kind: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
};
onBeforeUnmount(() => {
  if (resetTimer !== undefined) clearTimeout(resetTimer);
});
</script>

<template>
  <div class="space-y-3">
    <slot name="info" />

    <div v-if="pkceLoading" class="flex items-center gap-2 text-sm text-gray-400">
      <Spinner class="size-4" /> Preparing PKCE flow&hellip;
    </div>

    <div v-else-if="pkce" class="space-y-2">
      <p class="text-xs font-medium text-gray-500">Authorize URL</p>
      <a :href="pkce.authorize_url" :title="pkce.authorize_url" target="_blank" rel="noopener" class="block truncate text-xs text-accent-cyan hover:underline">
        {{ pkce.authorize_url }}
      </a>
      <div class="flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
        <Button size="sm" variant="secondary" @click="copy(pkce.authorize_url)">
          <i class="i-lucide-clipboard size-3.5" /> Copy URL
        </Button>
        <span v-if="status.kind === 'copied'" class="text-accent-emerald">Copied</span>
        <span v-else-if="status.kind === 'failed'" class="text-accent-rose">Copy failed: {{ status.message }}</span>
      </div>
    </div>

    <p v-if="pkceError" class="text-xs text-accent-rose">{{ pkceError }}</p>

    <Textarea
      v-model="callbackUrlText"
      :rows="3"
      monospace
      :placeholder="placeholder"
    />
  </div>
</template>
