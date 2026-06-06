<script setup lang="ts">
// Tone-accented radio card.

import { computed } from 'vue';

type Tone = 'amber' | 'emerald' | 'cyan';

const props = defineProps<{
  selected: boolean;
  tone: Tone;
  title: string;
  subtitle: string;
}>();

defineEmits<{ select: [] }>();

const TONE_CLASSES: Record<Tone, { border: string; swatch: string }> = {
  amber: { border: 'border-accent-amber/40 bg-accent-amber/5', swatch: 'bg-accent-amber/15 text-accent-amber' },
  emerald: { border: 'border-accent-emerald/40 bg-accent-emerald/5', swatch: 'bg-accent-emerald/15 text-accent-emerald' },
  cyan: { border: 'border-accent-cyan/40 bg-accent-cyan/5', swatch: 'bg-accent-cyan/15 text-accent-cyan' },
};

const toneStyle = computed(() => TONE_CLASSES[props.tone]);
</script>

<template>
  <button
    type="button"
    class="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors"
    :class="selected ? toneStyle.border : 'border-white/[0.14] bg-surface-800/55 hover:border-white/25 hover:bg-surface-800/75'"
    @click="$emit('select')"
  >
    <span
      class="grid size-8 shrink-0 place-items-center rounded-md"
      :class="toneStyle.swatch"
    >
      <slot name="icon" />
    </span>
    <span class="min-w-0">
      <span class="block text-sm font-semibold text-white">{{ title }}</span>
      <span class="mt-0.5 block text-xs text-gray-400">{{ subtitle }}</span>
    </span>
  </button>
</template>
