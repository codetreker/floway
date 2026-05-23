import { html } from 'hono/html';

import { dashboardAssets } from './dashboard/client.tsx';
import { renderDashboardHeader, renderKeysTab, renderModelsTab, renderPerformanceTab, renderSettingsTab, renderUsageTab } from './dashboard/tabs.tsx';
import { Layout } from './layout.tsx';

export function DashboardPage() {
  return Layout({
    title: 'Dashboard',
    children: html`
      <div class="min-h-screen" x-cloak x-data="dashboardApp()" x-init="init()">
        <div class="fixed top-0 left-1/4 w-[500px] h-[300px] bg-accent-cyan/3 rounded-full blur-[100px] pointer-events-none"></div>
        <div class="fixed top-0 right-1/4 w-[400px] h-[250px] bg-accent-emerald/3 rounded-full blur-[100px] pointer-events-none"></div>

        ${renderDashboardHeader()}

        <main class="max-w-6xl mx-auto px-4 sm:px-6 pt-4 sm:pt-5 pb-8">${renderSettingsTab()} ${renderModelsTab()} ${renderKeysTab()} ${renderUsageTab()} ${renderPerformanceTab()}</main>
      </div>

      ${dashboardAssets()}
    `,
  });
}
