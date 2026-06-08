import type { UpstreamRecord } from './model.ts';

// Subset of the gateway-internal Repo that provider-layer code actually reads
// from. packages/gateway wires its concrete repo accessor at boot via
// `initProviderRepo` so provider-package helpers never reach back into the
// gateway.
export interface CacheRepo {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

// Slim upstream-state surface for providers that own autonomous runtime state
// (e.g. Codex's rotated tokens). Structurally compatible with the full
// UpstreamRepo in packages/gateway, so the wiring stays a single accessor.
export interface UpstreamsRepoSlim {
  getById(id: string): Promise<UpstreamRecord | null>;
  saveState(id: string, newState: unknown, options: { expectedState: unknown }): Promise<{ updated: boolean }>;
}

export interface ProviderRepo {
  cache: CacheRepo;
  upstreams: UpstreamsRepoSlim;
}

let _accessor: (() => ProviderRepo) | null = null;

// Called once at boot from packages/gateway; gives provider helpers a callable
// that returns the live repo (lazy so the accessor can run after initRepo).
export const initProviderRepo = (accessor: () => ProviderRepo): void => {
  _accessor = accessor;
};

export const getProviderRepo = (): ProviderRepo => {
  if (!_accessor) throw new Error('Provider repo not initialized — call initProviderRepo() first');
  return _accessor();
};
