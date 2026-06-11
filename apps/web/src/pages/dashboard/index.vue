<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';

import { useAuthStore } from '../../stores/auth.ts';

const router = useRouter();
const auth = useAuthStore();

onMounted(() => {
  void router.replace(auth.isAdmin ? '/dashboard/settings' : '/dashboard/keys');
});
</script>

<template>
  <div class="grid place-items-center py-12 text-sm text-gray-500">Redirecting…</div>
</template>
