<script setup lang="ts">
import { useNow } from '@vueuse/core';
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from 'reka-ui';
import { computed } from 'vue';

import type { ProxyRecord } from '../../api/types.ts';
import { useProxiesStore } from '../../composables/useProxies.ts';
import { formatCountdown } from '../../utils/format-countdown.ts';

const DIRECT = 'direct';

const list = defineModel<string[]>({ required: true });

const props = defineProps<{
  // null in create mode; backoff rows need a saved upstream id.
  upstreamId: string | null;
}>();

const { proxies, backoffsByProxyId } = useProxiesStore();

const proxiesById = computed<Map<string, ProxyRecord>>(() => {
  const map = new Map<string, ProxyRecord>();
  for (const p of proxies.value ?? []) map.set(p.id, p);
  return map;
});

const proxiesNotInList = computed<ProxyRecord[]>(() => {
  const used = new Set(list.value);
  return (proxies.value ?? []).filter(p => !used.has(p.id));
});

const directInList = computed(() => list.value.includes(DIRECT));

const labelFor = (entry: string): string => {
  if (entry === DIRECT) return 'direct';
  // Non-direct, non-orphan entries reach this path: the template only
  // renders the labelFor branch when isOrphan(entry) is false, which
  // means proxiesById has the row.
  return proxiesById.value.get(entry)!.name;
};

// True for entries that name a proxy id we don't know about — typically a
// row that was hand-removed from the proxies table after this upstream
// referenced it. We render these distinctively and let the operator
// remove them in one click instead of silently masquerading as a normal
// entry whose label happens to be a UUID.
const isOrphan = (entry: string): boolean => entry !== DIRECT && !proxiesById.value.has(entry);

// Live tick so the badge countdown ticks visibly without the parent reloading.
const now = useNow({ interval: 1000 });

interface ActiveBackoff {
  expiresIn: string;
  failCount: number;
  lastError: string | null;
}

const activeBackoffByEntry = computed<Map<string, ActiveBackoff>>(() => {
  if (props.upstreamId === null) return new Map();
  const map = new Map<string, ActiveBackoff>();
  const nowSec = Math.floor(now.value.getTime() / 1000);
  for (const entry of list.value) {
    if (entry === DIRECT) continue;
    const rows = backoffsByProxyId.value.get(entry);
    // `>=` keeps the entry's badge visible during its expiry second so the
    // countdown's `now` edge label is reachable; a strict `>` would hide it
    // before the displayed delta could hit zero.
    const row = rows?.find(r => r.upstream_id === props.upstreamId && r.expires_at >= nowSec);
    if (row) {
      map.set(entry, {
        expiresIn: formatCountdown((row.expires_at - nowSec) * 1000),
        failCount: row.fail_count,
        lastError: row.last_error,
      });
    }
  }
  return map;
});

const removeAt = (index: number) => {
  const next = [...list.value];
  next.splice(index, 1);
  list.value = next;
};

const moveUp = (index: number) => {
  if (index <= 0) return;
  const next = [...list.value];
  const tmp = next[index]!;
  next[index] = next[index - 1]!;
  next[index - 1] = tmp;
  list.value = next;
};

const moveDown = (index: number) => {
  if (index >= list.value.length - 1) return;
  const next = [...list.value];
  const tmp = next[index]!;
  next[index] = next[index + 1]!;
  next[index + 1] = tmp;
  list.value = next;
};

const append = (entry: string) => {
  list.value = [...list.value, entry];
};
</script>

<template>
  <section>
    <p class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
      Proxy Fallback List <span class="text-accent-cyan">({{ list.length }})</span>
    </p>

    <div v-if="list.length === 0" class="rounded-md border border-dashed border-white/[0.08] bg-surface-900/40 px-3 py-2.5 text-xs text-gray-500">
      No fallback list configured — defaults to direct.
    </div>

    <ul v-else class="divide-y divide-white/[0.06]">
      <li
        v-for="(entry, index) in list"
        :key="entry"
        class="flex items-center gap-2 px-1 py-2 text-sm"
      >
        <div class="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            class="inline-flex h-7 w-7 items-center justify-center rounded-md p-1 text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan disabled:pointer-events-none disabled:opacity-30"
            :disabled="index === 0"
            aria-label="Move entry up"
            title="Move up"
            @click="moveUp(index)"
          >
            <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="m18 15-6-6-6 6" />
            </svg>
          </button>
          <button
            type="button"
            class="inline-flex h-7 w-7 items-center justify-center rounded-md p-1 text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan disabled:pointer-events-none disabled:opacity-30"
            :disabled="index === list.length - 1"
            aria-label="Move entry down"
            title="Move down"
            @click="moveDown(index)"
          >
            <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>

        <span
          class="min-w-0 flex-1 truncate"
          :class="[
            entry === DIRECT ? 'font-mono text-gray-300' : (isOrphan(entry) ? 'font-mono text-accent-rose' : 'text-white'),
          ]"
          :title="entry === DIRECT ? 'No proxy — connect directly' : entry"
        >
          <template v-if="isOrphan(entry)">Unknown proxy · {{ entry }}</template>
          <template v-else>{{ labelFor(entry) }}</template>
        </span>

        <span
          v-if="activeBackoffByEntry.get(entry)"
          class="shrink-0 text-[10px] font-medium text-accent-amber"
          :title="activeBackoffByEntry.get(entry)?.lastError ?? undefined"
        >
          backoff {{ activeBackoffByEntry.get(entry)?.expiresIn }} · {{ activeBackoffByEntry.get(entry)?.failCount }}
          fail{{ activeBackoffByEntry.get(entry)?.failCount === 1 ? '' : 's' }}
        </span>

        <button
          type="button"
          class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-rose"
          aria-label="Remove entry"
          title="Remove"
          @click="removeAt(index)"
        >
          <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </li>
    </ul>

    <div class="mt-2">
      <DropdownMenuRoot>
        <DropdownMenuTrigger
          class="inline-flex h-9 w-full items-center justify-between rounded-[10px] border border-white/[0.06] bg-surface-700 px-3 text-sm text-gray-300 transition-colors hover:border-white/[0.1] focus:border-accent-cyan/50 focus:outline-none focus:ring-1 focus:ring-accent-cyan/30"
        >
          <span>+ Add proxy</span>
          <svg class="size-4 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent
            align="start"
            :side-offset="4"
            class="z-50 w-[var(--reka-dropdown-menu-trigger-width)] min-w-[8rem] overflow-hidden rounded-[10px] border border-white/[0.06] bg-surface-800 p-1 text-white shadow-xl"
          >
            <DropdownMenuItem
              v-if="!directInList"
              class="flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 font-mono text-sm text-gray-300 outline-none data-[highlighted]:bg-accent-cyan/10 data-[highlighted]:text-accent-cyan"
              @select="append(DIRECT)"
            >
              direct
            </DropdownMenuItem>
            <DropdownMenuItem
              v-for="p in proxiesNotInList"
              :key="p.id"
              class="flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm text-white outline-none data-[highlighted]:bg-accent-cyan/10 data-[highlighted]:text-accent-cyan"
              @select="append(p.id)"
            >
              {{ p.name }}
            </DropdownMenuItem>
            <p
              v-if="proxiesNotInList.length === 0 && directInList"
              class="px-2 py-1.5 text-xs text-gray-500"
            >
              All proxies already added.
            </p>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>
    </div>
  </section>
</template>
