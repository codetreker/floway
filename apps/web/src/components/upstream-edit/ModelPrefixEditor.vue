<script setup lang="ts">
// Editor for an upstream's optional model name prefix. The model is the
// nullable wire shape; the empty-prefix string represents "no prefix" and
// projects back to null at the boundary. The pill rows below the input
// surface the two AddressableForm flags and enforce `listed ⊆ addressable`
// the same way the control-plane normalize step does on save.

import { computed, watch } from 'vue';

import type { AddressableForm, ModelPrefixConfig } from '../../api/types.ts';
import { MODEL_PREFIX_MAX_LENGTH, MODEL_PREFIX_REGEX } from '@floway-dev/provider/model-prefix';
import { Input } from '@floway-dev/ui';

const model = defineModel<ModelPrefixConfig | null>({ required: true });

// Mirror prefixInvalid up so the parent's save() can short-circuit before
// round-tripping a known-malformed value through Zod for a 400.
const emit = defineEmits<{ 'update:invalid': [invalid: boolean] }>();

// Canonical ordered form table — drives both the v-for label rendering and
// the byte-identical payload normalize step (the literal order here matches
// normalizeModelPrefix in @floway-dev/provider).
const FORMS: readonly { id: AddressableForm; label: string }[] = [
  { id: 'unprefixed', label: 'Unprefixed' },
  { id: 'prefixed', label: 'Prefixed' },
];

const write = (draft: ModelPrefixConfig) => {
  if (draft.prefix === '') { model.value = null; return; }
  const aSet = new Set(draft.addressable);
  const lSet = new Set(draft.listed);
  const addressableSorted = FORMS.flatMap(f => aSet.has(f.id) ? [f.id] : []);
  const listedSorted = FORMS.flatMap(f => aSet.has(f.id) && lSet.has(f.id) ? [f.id] : []);
  model.value = { prefix: draft.prefix, addressable: addressableSorted, listed: listedSorted };
};

const prefixText = computed<string>({
  get: () => model.value?.prefix ?? '',
  // First enable: when prefix transitions null → non-empty, default to the
  // unprefixed form (addressable + listed) so bare-id routing is unchanged
  // until the operator opts the prefixed form in via toggleAddressable /
  // toggleListed.
  set: text => write({
    prefix: text,
    addressable: model.value?.addressable ?? ['unprefixed'],
    listed: model.value?.listed ?? ['unprefixed'],
  }),
});

const prefixInvalid = computed(() => {
  const v = prefixText.value;
  if (v === '') return false;
  return !MODEL_PREFIX_REGEX.test(v) || v.length > MODEL_PREFIX_MAX_LENGTH;
});

watch(prefixInvalid, invalid => emit('update:invalid', invalid), { immediate: true });

const toggleAddressable = (form: AddressableForm) => {
  if (!model.value) return;
  const current = new Set(model.value.addressable);
  if (current.has(form)) {
    // Refuse to clear the last remaining addressable form — an upstream with
    // a prefix but no way to route to it is meaningless and the backend
    // rejects it.
    if (current.size === 1) return;
    current.delete(form);
  } else {
    current.add(form);
  }
  write({ ...model.value, addressable: [...current], listed: [...current].filter(f => model.value!.listed.includes(f)) });
};

const toggleListed = (form: AddressableForm) => {
  if (!model.value) return;
  if (!model.value.addressable.includes(form)) return;
  const current = new Set(model.value.listed);
  if (current.has(form)) current.delete(form);
  else current.add(form);
  write({ ...model.value, addressable: [...model.value.addressable], listed: [...current] });
};
</script>

<template>
  <div>
    <p class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Model Name Prefix</p>
    <Input
      v-model="prefixText"
      :invalid="prefixInvalid"
      placeholder="e.g. openrouter/ — leave empty to disable"
      class="mb-1.5 font-mono"
    />
    <p v-if="prefixInvalid" class="text-[11px] text-accent-rose">
      Must end with <code class="font-mono">/</code>, contain only letters, digits, dots, hyphens, underscores, or slashes, and be at most {{ MODEL_PREFIX_MAX_LENGTH }} characters.
    </p>
    <p v-else class="text-[11px] text-gray-600">
      Matched as a literal prefix on incoming model ids. Must end with <code class="font-mono">/</code>.
    </p>

    <template v-if="model && !prefixInvalid">
      <div class="mt-3 -mx-1">
        <div class="flex items-center justify-between gap-3 border-t border-white/[0.06] px-1 py-2.5">
          <div class="min-w-0">
            <span class="block text-xs text-white">Addressable as</span>
            <span class="block text-[11px] text-gray-500">forms clients can use to route here</span>
          </div>
          <fieldset class="flex shrink-0 items-center gap-1 text-[11px]">
            <label
              v-for="form in FORMS"
              :key="`addr-${form.id}`"
              class="flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 transition-colors"
              :class="model.addressable.includes(form.id)
                ? 'border-accent-cyan/40 bg-accent-cyan/15 text-accent-cyan'
                : 'border-white/10 text-gray-500 hover:bg-white/5'"
            >
              <input
                type="checkbox"
                class="sr-only"
                :checked="model.addressable.includes(form.id)"
                :disabled="model.addressable.length === 1 && model.addressable[0] === form.id"
                @change="toggleAddressable(form.id)"
              >
              <span>{{ form.label }}</span>
            </label>
          </fieldset>
        </div>
        <div class="flex items-center justify-between gap-3 border-t border-white/[0.06] px-1 py-2.5">
          <div class="min-w-0">
            <span class="block text-xs text-white">Show in <code class="font-mono text-gray-400">/v1/models</code></span>
            <span class="block text-[11px] text-gray-500">hidden forms stay addressable as private aliases</span>
          </div>
          <fieldset class="flex shrink-0 items-center gap-1 text-[11px]">
            <label
              v-for="form in FORMS"
              :key="`list-${form.id}`"
              class="flex items-center gap-1 rounded border px-1.5 py-0.5 transition-colors"
              :class="[
                model.addressable.includes(form.id) ? 'cursor-pointer' : 'cursor-not-allowed opacity-40',
                model.listed.includes(form.id) && model.addressable.includes(form.id)
                  ? 'border-accent-emerald/40 bg-accent-emerald/15 text-accent-emerald'
                  : 'border-white/10 text-gray-500 hover:bg-white/5',
              ]"
            >
              <input
                type="checkbox"
                class="sr-only"
                :checked="model.listed.includes(form.id) && model.addressable.includes(form.id)"
                :disabled="!model.addressable.includes(form.id)"
                @change="toggleListed(form.id)"
              >
              <span>{{ form.label }}</span>
            </label>
          </fieldset>
        </div>
      </div>
      <p class="mt-2 text-[11px] text-gray-600">
        Example: <code class="font-mono text-gray-400">gpt-4o</code>, <code class="font-mono text-gray-400">{{ model.prefix + 'gpt-4o' }}</code>
      </p>
    </template>
  </div>
</template>
