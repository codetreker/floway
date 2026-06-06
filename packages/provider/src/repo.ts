// Subset of the proxy-internal Repo that provider-layer code actually reads from
// (KV-style cache only). packages/proxy wires its concrete repo accessor at boot via
// `initProviderRepo` so provider-package helpers never reach back into the proxy.
export interface CacheRepo {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

export interface ProviderRepo {
  cache: CacheRepo;
}

let _accessor: (() => ProviderRepo) | null = null;

// Called once at boot from the api side; gives provider helpers a callable that
// returns the live repo (lazy so the accessor can run after initRepo).
export const initProviderRepo = (accessor: () => ProviderRepo): void => {
  _accessor = accessor;
};

export const getProviderRepo = (): ProviderRepo => {
  if (!_accessor) throw new Error('Provider repo not initialized — call initProviderRepo() first');
  return _accessor();
};
