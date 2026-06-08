import type { ExecutionContext } from 'hono';

import { bootstrapCloudflarePlatform, type CloudflareEnv } from './src/bootstrap.ts';
import {
  app,
  initBackgroundSchedulerResolver,
  initRepo,
  runScheduledMaintenance,
  SqlRepo,
} from '@floway-dev/gateway';

initBackgroundSchedulerResolver(c => promise => c.executionCtx.waitUntil(promise));

export default {
  fetch(req: Request, env: CloudflareEnv, ctx: ExecutionContext) {
    const { db } = bootstrapCloudflarePlatform(env);
    initRepo(new SqlRepo(db));
    return app.fetch(req, env, ctx);
  },
  scheduled(_controller: unknown, env: CloudflareEnv, ctx: ExecutionContext) {
    const { db } = bootstrapCloudflarePlatform(env);
    initRepo(new SqlRepo(db));
    ctx.waitUntil(runScheduledMaintenance());
  },
};
