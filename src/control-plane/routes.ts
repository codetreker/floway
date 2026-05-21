import { type Context, Hono, type Next } from 'hono';

import { createKey, deleteKey, listKeys, renameKey, rotateKey } from './api-keys/routes.ts';
import { authGithub, authGithubDisconnect, authGithubOrder, authGithubPoll, authLogin, authLogout, authMe } from './auth/routes.ts';
import { copilotQuota } from './copilot-quota/routes.ts';
import { exportData, importData } from './data-transfer/routes.ts';
import { controlPlaneModels } from './models/routes.ts';
import { performanceOverview, performanceTelemetry } from './performance/routes.ts';
import { getSearchConfigRoute, putSearchConfigRoute, testSearchConfigRoute } from './search-config/routes.ts';
import { searchUsage } from './search-usage/routes.ts';
import { tokenUsage } from './token-usage/routes.ts';
import { createUpstream, deleteUpstream, listOptionalFixes, listUpstreams, testUpstream, updateUpstream } from './upstreams/routes.ts';
import { DashboardPage } from '../ui/dashboard.tsx';
import { LoginPage } from '../ui/login.tsx';

const adminOnlyMiddleware = async (c: Context, next: Next) => {
  if (!c.get('isAdmin')) {
    return c.json({ error: 'Dashboard key required' }, 403);
  }
  await next();
};

export const mountControlPlane = (app: Hono) => {
  app.get('/', c => {
    const accept = c.req.header('accept') ?? '';
    if (accept.includes('application/json') && !accept.includes('text/html')) {
      return c.json({ status: 'ok', service: 'copilot-gateway' });
    }
    return c.html(LoginPage());
  });
  app.get('/dashboard', c => c.html(DashboardPage()));
  app.get('/favicon.ico', () => new Response(null, { status: 204 }));

  app.post('/auth/login', authLogin);
  app.post('/auth/logout', authLogout);

  const adminAuth = new Hono();
  adminAuth.use('*', adminOnlyMiddleware);
  adminAuth.get('/github', authGithub);
  adminAuth.post('/github/poll', authGithubPoll);
  adminAuth.delete('/github/:id', authGithubDisconnect);
  adminAuth.post('/github/order', authGithubOrder);
  adminAuth.get('/me', authMe);
  app.route('/auth', adminAuth);

  app.get('/api/keys', listKeys);
  app.get('/api/token-usage', tokenUsage);
  app.get('/api/search-usage', searchUsage);
  app.get('/api/performance', performanceTelemetry);
  app.get('/api/performance/overview', performanceOverview);
  app.get('/api/models', controlPlaneModels);

  const adminApi = new Hono();
  adminApi.use('*', adminOnlyMiddleware);
  adminApi.get('/copilot-quota', copilotQuota);
  adminApi.post('/keys', createKey);
  adminApi.post('/keys/:id/rotate', rotateKey);
  adminApi.patch('/keys/:id', renameKey);
  adminApi.delete('/keys/:id', deleteKey);
  adminApi.get('/upstreams', listUpstreams);
  adminApi.get('/upstream-fixes', listOptionalFixes);
  adminApi.post('/upstreams', createUpstream);
  adminApi.patch('/upstreams/:id', updateUpstream);
  adminApi.delete('/upstreams/:id', deleteUpstream);
  adminApi.post('/upstreams/:id/test', testUpstream);
  adminApi.get('/search-config', getSearchConfigRoute);
  adminApi.put('/search-config', putSearchConfigRoute);
  adminApi.post('/search-config/test', testSearchConfigRoute);
  adminApi.get('/export', exportData);
  adminApi.post('/import', importData);
  app.route('/api', adminApi);
};
