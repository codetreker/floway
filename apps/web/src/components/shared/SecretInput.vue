<script setup lang="ts">
import { computed, ref } from 'vue';

import { Input } from '@floway-dev/ui';

defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{
  modelValue?: string | number | null;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  size?: 'sm' | 'md';
}>(), {
  size: 'md',
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const autofillGuardLocked = ref(true);
const hasValue = computed(() => String(props.modelValue ?? '').length > 0);
const readonly = computed(() => !props.disabled && autofillGuardLocked.value && !hasValue.value);

const unlockAutofillGuard = () => {
  autofillGuardLocked.value = false;
};

const lockAutofillGuardIfEmpty = () => {
  if (!hasValue.value) autofillGuardLocked.value = true;
};
</script>

<template>
  <Input
    v-bind="$attrs"
    :model-value="modelValue"
    type="password"
    autocomplete="new-password"
    autocapitalize="off"
    autocorrect="off"
    spellcheck="false"
    data-1p-ignore="true"
    data-lpignore="true"
    data-bwignore="true"
    data-form-type="other"
    :placeholder="placeholder"
    :disabled="disabled"
    :invalid="invalid"
    :size="size"
    :readonly="readonly"
    @blur="lockAutofillGuardIfEmpty"
    @focus="unlockAutofillGuard"
    @keydown="unlockAutofillGuard"
    @paste="unlockAutofillGuard"
    @pointerdown="unlockAutofillGuard"
    @update:model-value="value => emit('update:modelValue', value)"
  />
</template>
