import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { mountControlPlane } from './control-plane/routes.ts';
import { mountDataPlane } from './data-plane/routes.ts';
import { authMiddleware } from './middleware/auth.ts';
import { internalErrorResponse } from './middleware/internal-error-response.ts';

export const app = new Hono();

app.onError(internalErrorResponse);

app.use('*', logger());
app.use('*', cors());
app.use('*', authMiddleware);

mountControlPlane(app);
mountDataPlane(app);
