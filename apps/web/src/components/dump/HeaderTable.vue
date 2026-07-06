<script setup lang="ts">
import { ref } from 'vue';

import { isSensitiveHeader, redactHeaderValue } from './header-redact.ts';

defineProps<{
  headers: ReadonlyArray<readonly [string, string]>;
}>();

const revealed = ref<Set<number>>(new Set());
const isRevealed = (index: number): boolean => revealed.value.has(index);
const toggleReveal = (index: number): void => {
  const next = new Set(revealed.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  revealed.value = next;
};
</script>

<template>
  <table class="w-full text-xs">
    <tbody class="divide-y divide-white/[0.03]">
      <tr v-for="(pair, i) in headers" :key="i">
        <td class="w-44 py-1.5 pr-3 align-top font-mono text-gray-500">{{ pair[0] }}</td>
        <td class="py-1.5 align-top font-mono text-gray-300">
          <span class="break-all">
            {{ isSensitiveHeader(pair[0]) && !isRevealed(i) ? redactHeaderValue(pair[1]) : pair[1] }}
          </span>
          <button
            v-if="isSensitiveHeader(pair[0])"
            type="button"
            class="ml-1.5 inline-flex size-3.5 shrink-0 translate-y-[1px] items-center justify-center rounded text-gray-500 transition-colors hover:bg-white/[0.06] hover:text-gray-200"
            :title="isRevealed(i) ? 'Hide value' : 'Reveal value'"
            @click="toggleReveal(i)"
          >
            <svg v-if="isRevealed(i)" class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
              <path d="m1 1 22 22" />
            </svg>
            <svg v-else class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </td>
      </tr>
    </tbody>
  </table>
</template>
