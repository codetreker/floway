import { useLocalStorage } from '@vueuse/core';
import { defineStore } from 'pinia';
import { computed } from 'vue';

export interface AuthUser {
  id: number;
  username: string;
  isAdmin: boolean;
  canViewGlobalTelemetry: boolean;
  upstreamIds: string[] | null;
}

export interface AuthIdentity {
  token: string;
  user: AuthUser;
}

const STORAGE_KEY = 'floway-auth';

const isAuthIdentity = (value: unknown): value is AuthIdentity => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { token?: unknown; user?: unknown };
  if (typeof v.token !== 'string') return false;
  if (typeof v.user !== 'object' || v.user === null) return false;
  const u = v.user as { id?: unknown; username?: unknown; isAdmin?: unknown; canViewGlobalTelemetry?: unknown; upstreamIds?: unknown };
  if (typeof u.id !== 'number' || typeof u.username !== 'string') return false;
  if (typeof u.isAdmin !== 'boolean' || typeof u.canViewGlobalTelemetry !== 'boolean') return false;
  if (u.upstreamIds !== null && !(Array.isArray(u.upstreamIds) && u.upstreamIds.every(x => typeof x === 'string'))) return false;
  return true;
};

export const useAuthStore = defineStore('auth', () => {
  const identity = useLocalStorage<AuthIdentity | null>(STORAGE_KEY, null, {
    serializer: {
      read: raw => {
        if (!raw) return null;
        try {
          const parsed: unknown = JSON.parse(raw);
          return isAuthIdentity(parsed) ? parsed : null;
        } catch {
          return null;
        }
      },
      write: value => value === null ? '' : JSON.stringify(value),
    },
  });

  const isAuthenticated = computed(() => identity.value !== null);
  const isAdmin = computed(() => identity.value?.user.isAdmin === true);
  const authToken = computed(() => identity.value?.token ?? null);
  const currentUser = computed(() => identity.value?.user ?? null);
  const canViewGlobalTelemetry = computed(() => identity.value?.user.canViewGlobalTelemetry === true);

  const setAuth = (next: AuthIdentity) => { identity.value = next; };
  const setUser = (user: AuthUser) => {
    if (!identity.value) throw new Error('setUser called without an authenticated identity');
    identity.value = { token: identity.value.token, user };
  };
  const clearAuth = () => { identity.value = null; };

  return {
    identity,
    isAuthenticated,
    isAdmin,
    authToken,
    currentUser,
    canViewGlobalTelemetry,
    setAuth,
    setUser,
    clearAuth,
  };
});
