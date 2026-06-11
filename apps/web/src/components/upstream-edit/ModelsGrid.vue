<script setup lang="ts">
// Horizontal model card grid. Cards auto-fit to min 280px; the container
// caps height at ~2.5 rows so the cut-off third row reads as "scroll for
// more".

import ModelCard from './ModelCard.vue';
import { publicIdOf, type Row, titleFor } from './modelRows.ts';
import { OverlayScrollbars } from '@floway-dev/ui';

defineProps<{
  rows: Row[];
  selectedUiId: string | null;
  readOnly: boolean;
  allManual: boolean;
  // Returns true when this row has an auto counterpart (i.e. the Auto/Manual
  // mode pills should show). Computed by the parent because it depends on
  // both the row identity and the live autoModels list.
  hasAutoCounterpart: (row: Row) => boolean;
  isDisabled: (publicId: string) => boolean;
}>();

defineEmits<{
  select: [uiId: string];
  'set-disabled': [publicId: string, disabled: boolean];
  'set-mode': [uiId: string, mode: 'auto' | 'manual'];
}>();
</script>

<template>
  <OverlayScrollbars
    class="max-h-[13rem]"
    content-class="p-4"
    no-tabindex
    :v-scrollbar-offset="{ x: 2 }"
  >
    <p v-if="rows.length === 0" class="rounded-xl border border-dashed border-white/[0.08] p-4 text-center text-xs text-gray-500">
      <template v-if="readOnly">No models reported by this upstream yet.</template>
      <template v-else-if="allManual">No models yet — use the <span class="text-gray-300">Add model</span> button above.</template>
      <template v-else>No models yet — fetch the upstream list, or add one manually with the button above.</template>
    </p>

    <div
      v-else
      class="grid gap-2.5"
      style="grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));"
    >
      <ModelCard
        v-for="row in rows"
        :key="row.uiId"
        :display-name="titleFor(row)"
        :public-id="publicIdOf(row)"
        :enabled="!isDisabled(publicIdOf(row))"
        :selected="row.uiId === selectedUiId"
        :show-mode-pills="!readOnly && hasAutoCounterpart(row)"
        :mode="row.kind"
        @select="$emit('select', row.uiId)"
        @update:enabled="on => $emit('set-disabled', publicIdOf(row), !on)"
        @update:mode="next => $emit('set-mode', row.uiId, next)"
      />
    </div>
  </OverlayScrollbars>
</template>
