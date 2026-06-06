export type EnvGetter = (name: string) => string;

let _getEnv: EnvGetter | null = null;

export const initEnv = (fn: EnvGetter): void => {
  _getEnv = fn;
};

export const getEnv = (name: string): string => {
  if (!_getEnv) throw new Error('Env not initialized — call initEnv() first');
  return _getEnv(name);
};
