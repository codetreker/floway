let _getEnv: ((name: string) => string) | null = null;

export function initEnv(fn: (name: string) => string): void {
  _getEnv = fn;
}

export function getEnv(name: string): string {
  if (!_getEnv) throw new Error('Env not initialized - call initEnv() first');
  return _getEnv(name);
}
