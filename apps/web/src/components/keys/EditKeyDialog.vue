<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { ApiKey } from '../../api/types.ts';
import type { UpstreamOption } from '../../composables/useUpstreamOptions.ts';
import { useAuthStore } from '../../stores/auth.ts';
import UpstreamPicker, { type UpstreamPickerValue } from '../upstreams/UpstreamPicker.vue';
import { Button, Dialog, Input, Spinner } from '@floway-dev/ui';

const open = defineModel<boolean>('open');

const props = defineProps<{
  apiKey: ApiKey;
  upstreams: UpstreamOption[];
}>();

const emit = defineEmits<{ saved: [] }>();

const api = useApi();
const auth = useAuthStore();

const visibleUpstreams = computed<UpstreamOption[]>(() => {
  if (!auth.currentUser) throw new Error('EditKeyDialog rendered without an authenticated user');
  const cap = auth.currentUser.upstreamIds;
  if (cap === null) return props.upstreams;
  const allowed = new Set(cap);
  return props.upstreams.filter(u => allowed.has(u.id));
});

const name = ref('');
const upstreamSelection = ref<UpstreamPickerValue>({ override: false, ids: [] });
const saving = ref(false);
const error = ref<string | null>(null);

const reset = () => {
  name.value = props.apiKey.name;
  upstreamSelection.value = {
    override: props.apiKey.upstream_ids !== null,
    ids: props.apiKey.upstream_ids ?? [],
  };
  error.value = null;
};

watch(open, v => { if (v) reset(); }, { immediate: true });

const save = async () => {
  const trimmed = name.value.trim();
  if (!trimmed) {
    error.value = 'Name is required';
    return;
  }
  if (upstreamSelection.value.override && upstreamSelection.value.ids.length === 0) {
    error.value = 'Select at least one upstream, or turn off the override to use every upstream available to you.';
    return;
  }
  saving.value = true;
  error.value = null;
  const body = {
    name: trimmed,
    upstream_ids: upstreamSelection.value.override ? upstreamSelection.value.ids : null,
  };
  const { error: err } = await callApi(
    () => api.api.keys[':id'].$patch({ param: { id: props.apiKey.id }, json: body }),
  );
  saving.value = false;
  if (err) {
    error.value = err.message;
    return;
  }
  open.value = false;
  emit('saved');
};
</script>

<template>
  <Dialog v-model:open="open" title="Edit API Key" size="lg" :auto-focus-on-open="false">
    <div class="space-y-5">
      <div class="space-y-2">
        <label class="block text-xs font-medium text-gray-500">Name</label>
        <Input v-model="name" />
      </div>

      <UpstreamPicker
        v-model="upstreamSelection"
        :available="visibleUpstreams"
        title="Override Available Upstreams"
        inherit-description="When off, this key inherits the global upstream order."
      />

      <p v-if="error" class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">{{ error }}</p>

      <footer class="flex items-center justify-end gap-2">
        <Button variant="secondary" :disabled="saving" @click="open = false">Cancel</Button>
        <Button :loading="saving" @click="save">
          <Spinner v-if="saving" class="size-3.5" />
          Save changes
        </Button>
      </footer>
    </div>
  </Dialog>
</template>
