<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import SecretInput from '../shared/SecretInput.vue';
import { Button, Dialog } from '@floway-dev/ui';

const open = defineModel<boolean>('open');

const props = defineProps<
  | { mode: 'self'; targetUserId?: undefined; targetUsername?: undefined }
  | { mode: 'admin'; targetUserId: number; targetUsername: string }
>();

const emit = defineEmits<{ saved: [] }>();

const api = useApi();

const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const error = ref<string | null>(null);
const saving = ref(false);

watch(open, v => {
  if (!v) return;
  currentPassword.value = '';
  newPassword.value = '';
  confirmPassword.value = '';
  error.value = null;
}, { immediate: true });

const submit = async () => {
  if (!newPassword.value) {
    error.value = 'New password is required';
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    error.value = 'Passwords do not match';
    return;
  }
  if (props.mode === 'self' && !currentPassword.value) {
    error.value = 'Current password is required';
    return;
  }
  saving.value = true;
  error.value = null;
  try {
    const { error: err } = props.mode === 'self'
      ? await callApi(() => api.api.users.me.password.$patch({ json: { currentPassword: currentPassword.value, newPassword: newPassword.value } }))
      : await callApi(() => api.api.users[':id'].$patch({ param: { id: String(props.targetUserId) }, json: { password: newPassword.value } }));
    if (err) {
      error.value = err.message;
      return;
    }
    open.value = false;
    emit('saved');
  } finally {
    saving.value = false;
  }
};

const title = computed(() => {
  if (props.mode === 'self') return 'Change my password';
  return `Reset password — ${props.targetUsername}`;
});
</script>

<template>
  <Dialog v-model:open="open" :title="title" size="md" :auto-focus-on-open="false">
    <form class="space-y-4" @submit.prevent="submit">
      <div v-if="mode === 'self'" class="space-y-2">
        <label class="block text-xs font-medium text-gray-500">Current password</label>
        <SecretInput v-model="currentPassword" />
      </div>
      <div class="space-y-2">
        <label class="block text-xs font-medium text-gray-500">New password</label>
        <SecretInput v-model="newPassword" />
      </div>
      <div class="space-y-2">
        <label class="block text-xs font-medium text-gray-500">Confirm new password</label>
        <SecretInput v-model="confirmPassword" />
      </div>

      <p v-if="error" class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">{{ error }}</p>

      <p v-if="mode === 'self'" class="text-xs text-gray-500">
        Other devices currently logged in as you will be signed out.
      </p>

      <footer class="flex items-center justify-end gap-2">
        <Button variant="secondary" type="button" :disabled="saving" @click="open = false">Cancel</Button>
        <Button :loading="saving" type="submit">
          Save
        </Button>
      </footer>
    </form>
  </Dialog>
</template>
