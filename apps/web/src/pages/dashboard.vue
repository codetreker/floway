<script setup lang="ts">
import { computed, ref } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';

import { callApi, useApi } from '../api/client.ts';
import PasswordDialog from '../components/users/PasswordDialog.vue';
import { useAuthStore } from '../stores/auth.ts';
import { OverlayScrollbars } from '@floway-dev/ui';

interface TabDef {
  path: string;
  label: string;
  adminOnly?: boolean;
  // Extra path prefixes that should also mark this tab as active — e.g. the
  // upstream editor lives at /dashboard/upstreams/* but reads as Settings.
  alsoActiveFor?: string[];
}

const allTabs: TabDef[] = [
  { path: '/dashboard/settings', label: 'Settings', adminOnly: true, alsoActiveFor: ['/dashboard/upstreams'] },
  { path: '/dashboard/users', label: 'Users', adminOnly: true },
  { path: '/dashboard/models', label: 'Models' },
  { path: '/dashboard/keys', label: 'API Keys' },
  { path: '/dashboard/requests', label: 'Requests' },
  { path: '/dashboard/usage', label: 'Usage' },
  { path: '/dashboard/performance', label: 'Performance' },
];

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const api = useApi();

const tabs = computed(() => allTabs.filter(t => !t.adminOnly || auth.isAdmin));

const isTabActive = (tab: TabDef) =>
  route.path.startsWith(tab.path)
  || (tab.alsoActiveFor?.some(p => route.path.startsWith(p)) ?? false);

// Shared page-width contract: the upstream editor needs the room for its
// two-column workbench, and other pages look fine at the same width.
const mainClass = 'mx-auto w-full max-w-[1408px] px-4 py-6 sm:px-6';
const headerInnerClass = 'mx-auto w-full max-w-[1408px] flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 sm:px-6';

const passwordDialogOpen = ref(false);
const passwordToast = ref<string | null>(null);

const onPasswordChanged = () => {
  passwordToast.value = 'Password updated. Other devices have been signed out.';
  window.setTimeout(() => { passwordToast.value = null; }, 4000);
};

const logout = async () => {
  await callApi(() => api.auth.logout.$post());
  auth.clearAuth();
  await router.replace('/login');
};
</script>

<template>
  <div class="flex h-dvh min-h-0 flex-col overflow-hidden">
    <header class="z-50 shrink-0 border-b border-white/[0.05] bg-surface-900/80 backdrop-blur-md">
      <div :class="headerInnerClass">
        <div class="flex min-w-0 items-center gap-3">
          <div class="glow-border flex h-8 w-8 items-center justify-center rounded-lg bg-surface-700">
            <svg class="h-4 w-4 text-accent-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <span class="text-sm font-semibold tracking-tight text-white">Floway</span>
        </div>

        <OverlayScrollbars
          class="order-3 w-full max-w-full rounded-lg bg-surface-800 sm:order-none sm:w-fit"
          content-class="flex gap-1 p-0.5"
          no-tabindex
        >
          <RouterLink
            v-for="tab in tabs"
            :key="tab.path"
            :to="tab.path"
            class="shrink-0 rounded-md px-2 py-2 text-xs font-medium transition-all sm:px-4 sm:text-sm"
            :class="isTabActive(tab) ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
          >
            {{ tab.label }}
          </RouterLink>
        </OverlayScrollbars>

        <div class="group relative ml-auto shrink-0">
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-gray-300 hover:bg-surface-800 hover:text-white"
          >
            <span class="font-medium">{{ auth.currentUser?.username }}</span>
            <svg class="h-3 w-3 text-gray-500 transition-transform group-hover:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          <!-- The `pt-1` strip is a hover bridge: it keeps `.group:hover` true
               while the cursor crosses the gap between trigger and panel. -->
          <div class="invisible absolute right-0 top-full z-50 pt-1 opacity-0 transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
            <div class="min-w-[180px] rounded-md border border-white/[0.08] bg-surface-800 py-1 shadow-xl">
              <button
                type="button"
                class="flex w-full items-center px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-surface-700 hover:text-white"
                @click="passwordDialogOpen = true"
              >
                Change password
              </button>
              <button
                type="button"
                class="flex w-full items-center px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-surface-700 hover:text-white"
                @click="logout"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      </div>
    </header>

    <div v-if="passwordToast" class="border-b border-accent-emerald/40 bg-accent-emerald/10 px-4 py-2 text-center text-sm text-accent-emerald">
      {{ passwordToast }}
    </div>

    <OverlayScrollbars
      class="min-h-0 flex-1"
      content-class="min-h-full"
      no-tabindex
      :scrollbar-z-index="60"
    >
      <main :class="mainClass">
        <RouterView />
      </main>
    </OverlayScrollbars>

    <PasswordDialog
      v-model:open="passwordDialogOpen"
      mode="self"
      @saved="onPasswordChanged"
    />
  </div>
</template>
