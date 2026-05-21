import type { ExecutionContext } from 'hono';

import { app } from './src/app.ts';
import { type D1Database, D1Repo } from './src/repo/d1.ts';
import { initRepo } from './src/repo/index.ts';
import { initEnv } from './src/runtime/env.ts';

interface Env {
  DB: D1Database;
  [key: string]: unknown;
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    initEnv(n => (env[n] as string) ?? '');
    initRepo(new D1Repo(env.DB));
    return app.fetch(req, env, ctx);
  },
};
