// TODO: Delete and fully rewrite the frontend build when migrating to a bundler.
// This script prerenders Hono JSX components into static HTML as an interim
// stage before the SPA rewrite.

import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DashboardPage } from './src/dashboard.tsx';
import { LoginPage } from './src/login.tsx';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');

const writePage = async (relativePath: string, html: string) => {
  const target = join(dist, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, html, 'utf8');
};

await mkdir(dist, { recursive: true });

await writePage('index.html', String(LoginPage()));
await writePage('dashboard/index.html', String(DashboardPage()));

const favicon = join(here, 'src/favicon.ico');
await copyFile(favicon, join(dist, 'favicon.ico')).catch((err: NodeJS.ErrnoException) => {
  // No source favicon committed yet — leave dist/favicon.ico absent.
  if (err.code !== 'ENOENT') throw err;
});

console.log('apps/web: prerender complete');
