import type { Context } from 'hono';

export type BackgroundScheduler = (promise: Promise<unknown>) => void;

export const backgroundSchedulerFromContext = (c: Context): BackgroundScheduler | undefined => {
  try {
    const executionCtx = c.executionCtx;
    return promise => executionCtx.waitUntil(promise);
  } catch {
    return undefined;
  }
};
