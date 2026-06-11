<script setup lang="ts">
import { ref } from 'vue';

import { Switch } from '@floway-dev/ui';

defineProps<{
  displayName: string;
  publicId: string;
  enabled: boolean;
  selected: boolean;
  showModePills: boolean;
  mode: 'auto' | 'manual';
}>();

const emit = defineEmits<{
  select: [];
  'update:enabled': [next: boolean];
  'update:mode': [next: 'auto' | 'manual'];
}>();

const copyOk = ref(false);
let copyTimer: number | null = null;

const copy = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    copyOk.value = true;
    if (copyTimer !== null) window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => { copyOk.value = false; }, 1200);
  } catch {
    // Best-effort: silently ignore if the clipboard API is unavailable. The
    // id stays selectable by hand.
  }
};
</script>

<template>
  <div
    class="group relative flex cursor-pointer flex-col gap-1.5 rounded-xl border bg-surface-800 p-3 transition-colors"
    :class="selected
      ? 'border-accent-cyan/50 bg-accent-cyan/[0.04] shadow-[inset_0_0_0_1px_rgba(0,229,255,0.15)]'
      : 'border-white/[0.06] hover:border-white/15'"
    @click="emit('select')"
  >
    <span
      v-if="selected"
      class="absolute -left-px top-2.5 bottom-2.5 w-0.5 rounded-r bg-accent-cyan shadow-[0_0_6px_rgba(0,229,255,0.6)]"
      aria-hidden="true"
    />

    <div class="flex min-w-0 items-center gap-2.5">
      <span @click.stop>
        <Switch
          :model-value="enabled"
          size="sm"
          :aria-label="`Enable ${displayName}`"
          @update:model-value="next => emit('update:enabled', !!next)"
        />
      </span>
      <span
        class="min-w-0 flex-1 truncate text-sm font-semibold"
        :class="selected ? 'text-white' : 'text-gray-200'"
      >{{ displayName }}</span>
    </div>

    <div class="flex min-w-0 items-center gap-2 pl-[42px]">
      <span class="flex min-w-0 flex-1 items-center gap-1 font-mono text-[11px] text-gray-500">
        <span class="min-w-0 truncate">{{ publicId }}</span>
        <button
          type="button"
          class="grid size-5 shrink-0 place-items-center rounded text-gray-500 hover:bg-white/[0.06] hover:text-gray-200"
          :title="copyOk ? 'Copied!' : `Copy ${publicId}`"
          @click.stop="copy(publicId)"
        >
          <svg v-if="!copyOk" class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          <svg v-else class="size-3 text-accent-emerald" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </button>
      </span>
      <div v-if="showModePills" role="group" aria-label="Model source" class="flex shrink-0 items-center gap-px rounded-md border border-white/[0.06] bg-black/30 p-px" @click.stop>
        <button
          type="button"
          class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors"
          :class="mode === 'auto'
            ? 'bg-white/[0.08] text-white'
            : 'text-gray-500 hover:text-gray-300'"
          @click="emit('update:mode', 'auto')"
        >Auto</button>
        <button
          type="button"
          class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors"
          :class="mode === 'manual'
            ? 'bg-accent-cyan/20 text-accent-cyan'
            : 'text-gray-500 hover:text-gray-300'"
          @click="emit('update:mode', 'manual')"
        >Manual</button>
      </div>
    </div>
  </div>
</template>
