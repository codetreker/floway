<script setup lang="ts">
import { OverlayScrollbars } from '@floway-dev/ui';
import { computed } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';

import { useAuthStore } from '../stores/auth.ts';

// Tab labels and order mirror the prerender dashboard exactly. "API Keys" not
// "Keys"; admin-only Settings hides for API-key users; rest are visible to
// every authenticated identity.
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
  { path: '/dashboard/models', label: 'Models' },
  { path: '/dashboard/keys', label: 'API Keys' },
  { path: '/dashboard/usage', label: 'Usage' },
  { path: '/dashboard/performance', label: 'Performance' },
];

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const tabs = computed(() => allTabs.filter(t => !t.adminOnly || auth.isAdmin));

const isTabActive = (tab: TabDef) =>
  route.path.startsWith(tab.path)
  || (tab.alsoActiveFor?.some(p => route.path.startsWith(p)) ?? false);

// Shared page-width contract: the upstream editor needs the room for its
// two-column workbench, and other pages look fine at the same width.
const mainClass = 'mx-auto w-full max-w-[1408px] px-4 py-6 sm:px-6';
const headerInnerClass = 'mx-auto w-full max-w-[1408px] flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 sm:px-6';

const logout = async () => {
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

        <button type="button" class="btn-ghost ml-auto shrink-0 text-xs" @click="logout">Logout</button>
      </div>
    </header>

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
  </div>
</template>
