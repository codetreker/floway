export type RuntimeKind = 'cloudflare' | 'node';

let _kind: RuntimeKind | null = null;

export const initRuntimeKind = (kind: RuntimeKind): void => {
  _kind = kind;
};

export const getRuntimeKind = (): RuntimeKind => {
  if (!_kind) throw new Error('Runtime kind not initialized — call initRuntimeKind() first');
  return _kind;
};
