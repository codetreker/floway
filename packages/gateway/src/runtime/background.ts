import type { Context } from 'hono';

import type { BackgroundScheduler } from '@floway-dev/platform';

let _resolver: ((c: Context) => BackgroundScheduler) | null = null;

export const initBackgroundSchedulerResolver = (
  resolver: (c: Context) => BackgroundScheduler,
): void => {
  _resolver = resolver;
};

export const backgroundSchedulerFromContext = (c: Context): BackgroundScheduler => {
  if (!_resolver) throw new Error('Background scheduler resolver not initialized — call initBackgroundSchedulerResolver() first');
  return _resolver(c);
};
