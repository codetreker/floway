<script setup lang="ts">
import { computed } from 'vue';

import type { ProxyRecord } from '../../api/types.ts';
import { kindFromUri } from '@floway-dev/proxy/url-kind';

const props = defineProps<{
  proxy: ProxyRecord;
}>();

defineEmits<{
  edit: [];
  delete: [];
}>();

// Amber is reserved for backoff/warning everywhere in the dashboard, so no proxy-kind label uses it.
const kindBadgeClass = (kind: string) => {
  switch (kind) {
  case 'HTTPS':
  case 'VLESS':
  case 'VLESS-WS': return 'border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan';
  case 'SOCKS5': return 'border-accent-emerald/30 bg-accent-emerald/10 text-accent-emerald';
  case 'SS':
  case 'SS-2022':
  case 'TROJAN':
  case 'REALITY': return 'border-accent-violet/30 bg-accent-violet/10 text-accent-violet';
  default: return 'border-white/10 bg-white/5 text-gray-400';
  }
};

const kind = computed(() => kindFromUri(props.proxy.url));

// Strip userinfo AND the scheme before display: the kind badge already
// carries the protocol, so showing `ss://` next to an `SS` chip is noise.
// Shadowsocks and trojan URIs embed the secret as the userinfo segment,
// and we do not want it leaking into a tooltip. URL parsing is preferred —
// but on parse failure we still scrub the raw string with a minimal
// scheme+userinfo regex so a malformed row (e.g. one our parser rejects
// but contains userinfo anyway) cannot leak credentials through the
// fallback path.
const hostPreview = computed(() => {
  const raw = props.proxy.url;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/]*@)?/, '');
  }
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${parsed.hostname}${port}${parsed.pathname === '/' ? '' : parsed.pathname}`;
});
</script>

<template>
  <div class="flex items-center gap-3 rounded-lg border border-white/5 bg-surface-800/80 px-3 py-2">
    <span
      class="shrink-0 rounded border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide"
      :class="kindBadgeClass(kind)"
    >{{ kind }}</span>

    <span class="truncate text-sm font-semibold text-white">{{ proxy.name }}</span>
    <span class="min-w-0 flex-1 truncate font-mono text-xs text-gray-500" :title="hostPreview">{{ hostPreview }}</span>

    <div class="flex shrink-0 items-center gap-1">
      <button
        type="button"
        class="inline-flex h-8 w-8 items-center justify-center rounded-md p-1 text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan"
        aria-label="Edit proxy"
        title="Edit"
        @click="$emit('edit')"
      >
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          <path d="m15 5 4 4" />
        </svg>
      </button>
      <button
        type="button"
        class="inline-flex h-8 w-8 items-center justify-center rounded-md p-1 text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-rose"
        aria-label="Delete proxy"
        title="Delete"
        @click="$emit('delete')"
      >
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </button>
    </div>
  </div>
</template>
