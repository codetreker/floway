import { html } from 'hono/html';

function spinner(cls: string) {
  return html`
    <svg class="animate-spin ${cls}" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25" />
      <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75" />
    </svg>
  `;
}

function usageSummaryMetric(metric: string, label: string, valueExpression: string, skeletonWidth: string) {
  return html`
    <button
      type="button"
      @click="switchTokenChartMetric('${metric}')"
      class="text-center w-full rounded-md border border-transparent cursor-pointer transition-colors hover:border-white/10 focus:outline-none focus-visible:border-accent-cyan/40 px-2 py-2"
      :aria-pressed="tokenChartMetric === '${metric}'"
      title="Use ${label} for chart y-axis"
    >
      <span class="block text-xs mb-1" :class="tokenChartMetric === '${metric}' ? 'text-accent-cyan' : 'text-gray-500'">${label}</span>
      <template x-if="tokenLoading && !chartsReady">
        <span class="block h-7 ${skeletonWidth} mx-auto bg-surface-600 rounded animate-pulse"> </span>
      </template>
      <template x-if="!tokenLoading || chartsReady">
        <span class="block text-lg font-bold font-mono" :class="tokenChartMetric === '${metric}' ? 'text-accent-cyan' : 'text-white'" x-text="${valueExpression}"> </span>
      </template>
    </button>
  `;
}

function usageSummaryMetricPair(first: ReturnType<typeof html>, second: ReturnType<typeof html>) {
  return html` <div class="grid grid-cols-2 lg:grid-cols-1 gap-2">${first} ${second}</div> `;
}

function codeBlock(lang: string, ref: string, snippetFn: string, copyId: string) {
  return html`
    <div class="relative group">
      <pre
        class="bg-surface-900 rounded-xl p-4 pr-10 overflow-x-auto border border-white/[0.04]"
      ><code class="language-${lang}" x-ref="${ref}" x-effect="$el.textContent = ${snippetFn}(); Prism.highlightElement($el)"></code></pre>
      <button
        @click="copySnippet(${snippetFn}(), '${copyId}')"
        class="absolute top-2.5 right-2.5 p-1.5 rounded-md bg-surface-700/80 text-gray-500 hover:text-accent-cyan hover:bg-surface-600 transition-all opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100"
        aria-label="Copy snippet"
        :title="copied === '${copyId}' ? 'Copied!' : 'Copy'"
      >
        <svg x-show="copied !== '${copyId}'" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <svg x-show="copied === '${copyId}'" class="w-3.5 h-3.5 text-accent-emerald" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </button>
    </div>
  `;
}

function endpointRow(method: 'GET' | 'POST', path: string, name: string, docsHref: string) {
  const methodClass = method === 'GET' ? 'bg-accent-cyan/10 text-accent-cyan' : 'bg-accent-emerald/10 text-accent-emerald';

  return html`
    <div class="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap border-b border-white/[0.04] py-2 last:border-b-0">
      <span class="shrink-0 rounded px-2 py-0.5 font-mono text-[10px] font-bold ${methodClass}">${method}</span>
      <code class="min-w-0 max-w-[48%] truncate font-mono text-xs font-semibold text-gray-300 sm:max-w-[220px]">${path}</code>
      <span class="min-w-0 flex-1 truncate text-xs font-medium text-gray-500"> ${name} </span>
      <a href="${docsHref}" target="_blank" rel="noreferrer" class="ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-bold text-accent-cyan hover:underline">
        Docs
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M7 17 17 7" />
          <path d="M7 7h10v10" />
        </svg>
      </a>
    </div>
  `;
}

export function renderDashboardHeader() {
  return html`
    <header class="border-b border-white/5 bg-surface-900/80 backdrop-blur-md sticky top-0 z-50">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center gap-x-4 gap-y-3">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-8 h-8 rounded-lg bg-surface-700 glow-border flex items-center justify-center">
            <svg class="w-4 h-4 text-accent-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <span class="font-semibold text-white text-sm tracking-tight">Copilot Gateway</span>
        </div>

        <nav class="order-3 flex w-full max-w-full gap-1 overflow-x-auto rounded-lg bg-surface-800 p-0.5 sm:order-none sm:w-fit">
          <template x-if="isAdmin">
            <button
              @click="switchTab('settings')"
              class="shrink-0 px-2 py-2 rounded-md text-xs font-medium transition-all sm:px-4 sm:text-sm"
              :class="tab === 'settings' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
            >
              Settings
            </button>
          </template>
          <button
            @click="switchTab('models')"
            class="shrink-0 px-2 py-2 rounded-md text-xs font-medium transition-all sm:px-4 sm:text-sm"
            :class="tab === 'models' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
          >
            Models
          </button>
          <button
            @click="switchTab('keys')"
            class="shrink-0 px-2 py-2 rounded-md text-xs font-medium transition-all sm:px-4 sm:text-sm"
            :class="tab === 'keys' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
          >
            API Keys
          </button>
          <button
            @click="switchTab('usage')"
            class="shrink-0 px-2 py-2 rounded-md text-xs font-medium transition-all sm:px-4 sm:text-sm"
            :class="tab === 'usage' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
          >
            Usage
          </button>
          <button
            @click="switchTab('performance')"
            class="shrink-0 px-2 py-2 rounded-md text-xs font-medium transition-all sm:px-4 sm:text-sm"
            :class="tab === 'performance' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
          >
            Performance
          </button>
        </nav>

        <button @click="logout()" class="btn-ghost text-xs ml-auto shrink-0">Logout</button>
      </div>
    </header>
  `;
}

export function renderKeysTab() {
  return html`
    <div x-show="tab === 'keys'">
      <div class="glass-card p-5 sm:p-6 mb-6 animate-in">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
          <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">API Keys</span>
          <div x-show="isAdmin" class="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <input type="text" x-model="newKeyName" placeholder="Name" class="!text-xs !py-2.5 !px-3 !w-full sm:!w-32 !rounded-lg" @keydown.enter="createNewKey()" />
            <button @click="createNewKey()" class="btn-primary !text-xs !py-2.5 !px-3 !rounded-lg whitespace-nowrap w-full sm:w-auto" :disabled="!newKeyName.trim() || keyCreating">
              <span x-show="!keyCreating">+ Create</span>
              <span x-show="keyCreating" class="flex items-center gap-1.5"> ${spinner('h-3 w-3')} Creating… </span>
            </button>
          </div>
        </div>

        <div class="overflow-x-auto">
          <template x-if="keys.length === 0 && !keysLoading">
            <p class="text-sm text-gray-500 py-4 text-center">No API keys yet. Create one above.</p>
          </template>
          <template x-if="keysLoading && keys.length === 0">
            <div class="space-y-3 py-2">
              <div class="h-10 bg-surface-600 rounded animate-pulse"></div>
              <div class="h-10 bg-surface-600 rounded animate-pulse"></div>
            </div>
          </template>
          <template x-if="keys.length > 0">
            <table class="w-full min-w-[760px] text-sm">
              <thead>
                <tr class="border-b border-white/5">
                  <th class="text-left py-2 pr-4 pl-7 text-xs font-medium text-gray-500 uppercase tracking-widest">Name</th>
                  <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Key</th>
                  <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Created</th>
                  <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Last Used</th>
                  <th x-show="isAdmin" class="text-right py-2 pr-2 text-xs font-medium text-gray-500 uppercase tracking-widest">Actions</th>
                </tr>
              </thead>
              <tbody>
                <template x-for="k in keys" :key="k.id">
                  <tr
                    @click="selectedKeyId = k.id"
                    class="border-b border-white/[0.03] transition-colors cursor-pointer"
                    :class="selectedKeyId === k.id ? 'bg-accent-cyan/5 hover:bg-accent-cyan/8' : 'hover:bg-white/[0.02]'"
                  >
                    <td class="py-3 pr-4 pl-2">
                      <div class="flex items-center gap-2 min-w-0">
                        <div class="w-1.5 h-1.5 rounded-full shrink-0 transition-colors" :class="selectedKeyId === k.id ? 'bg-accent-cyan' : 'bg-transparent'"></div>
                        <span class="text-white font-medium truncate" x-text="k.name"></span>
                      </div>
                    </td>
                    <td class="py-3 pr-4">
                      <code class="text-xs font-mono text-gray-500 bg-surface-800 rounded px-2 py-1" x-text="truncateKey(k.key)"></code>
                    </td>
                    <td class="py-3 pr-4">
                      <span class="text-gray-500 text-xs cursor-default" :title="fullDateTime(k.created_at)" x-text="timeAgo(k.created_at)"></span>
                    </td>
                    <td class="py-3 pr-4">
                      <span x-show="k.last_used_at" class="text-gray-500 text-xs cursor-default" :title="fullDateTime(k.last_used_at)" x-text="timeAgo(k.last_used_at)"></span>
                      <span x-show="!k.last_used_at" class="text-gray-600 text-xs">Never</span>
                    </td>
                    <td class="py-3 pr-2 text-right">
                      <div class="flex items-center justify-end gap-1">
                        <button
                          @click.stop="copySnippet(k.key, 'key-' + k.id)"
                          class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-gray-600 hover:text-accent-cyan hover:bg-white/[0.04] transition-colors p-1"
                          aria-label="Copy API key"
                          title="Copy key"
                        >
                          <svg x-show="copied !== 'key-' + k.id" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                          <svg x-show="copied === 'key-' + k.id" class="w-4 h-4 text-accent-emerald" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </button>
                        <template x-if="isAdmin">
                          <button
                            @click.stop="renameKeyById(k.id, k.name)"
                            class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-gray-600 hover:text-accent-cyan hover:bg-white/[0.04] transition-colors p-1"
                            aria-label="Rename API key"
                            title="Rename key"
                          >
                            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                              <path d="m15 5 4 4" />
                            </svg>
                          </button>
                        </template>
                        <template x-if="isAdmin">
                          <button
                            @click.stop="rotateKeyById(k.id, k.name)"
                            class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-gray-600 hover:text-accent-amber hover:bg-white/[0.04] transition-colors p-1"
                            aria-label="Rotate API key"
                            :disabled="keyRotating === k.id"
                            title="Rotate key"
                          >
                            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <path d="M21.5 2v6h-6" />
                              <path d="M2.5 22v-6h6" />
                              <path d="M2.5 12a10 10 0 0 1 16.5-5.7L21.5 8" />
                              <path d="M21.5 12a10 10 0 0 1-16.5 5.7L2.5 16" />
                            </svg>
                          </button>
                        </template>
                        <template x-if="isAdmin">
                          <button
                            @click.stop="deleteKeyById(k.id, k.name)"
                            class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-gray-600 hover:text-accent-rose hover:bg-white/[0.04] transition-colors p-1"
                            aria-label="Delete API key"
                            :disabled="keyDeleting === k.id"
                            title="Delete key"
                          >
                            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </template>
                      </div>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </template>
        </div>
      </div>

      <div class="glass-card p-5 sm:p-6 animate-in delay-1">
        <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Configuration</span>
        <template x-if="selectedKeyId">
          <p class="text-xs text-accent-cyan mt-2 flex items-center gap-1.5">
            <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4" />
              <path d="M12 8h.01" />
            </svg>
            Configs below use the selected key.
          </p>
        </template>

        <template x-if="!modelsLoaded">
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-5">
            <div class="space-y-3">
              <div class="h-5 w-28 bg-surface-600 rounded animate-pulse"></div>
              <div class="h-7 w-40 bg-surface-600 rounded animate-pulse"></div>
              <div class="h-32 bg-surface-600 rounded-xl animate-pulse"></div>
            </div>
            <div class="space-y-3">
              <div class="h-5 w-20 bg-surface-600 rounded animate-pulse"></div>
              <div class="h-7 w-40 bg-surface-600 rounded animate-pulse"></div>
              <div class="h-32 bg-surface-600 rounded-xl animate-pulse"></div>
            </div>
          </div>
        </template>

        <template x-if="modelsLoaded">
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-5">
            <div>
              <div class="mb-3">
                <span class="text-sm font-semibold text-white">Claude Code</span>
              </div>

              <div class="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
                <div class="flex min-w-0 items-center gap-2">
                  <label class="text-xs text-gray-500">Model:</label>
                  <select
                    x-model="claudeModel"
                    class="max-w-full text-xs font-mono bg-surface-800 text-gray-300 border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-cyan/50 cursor-pointer"
                  >
                    <template x-for="m in claudeModelsBig" :key="m">
                      <option :value="m" x-text="m" :disabled="m === modelPickerSeparator"></option>
                    </template>
                  </select>
                </div>
                <div class="flex min-w-0 items-center gap-2">
                  <label class="text-xs text-gray-500">Sonnet:</label>
                  <select
                    x-model="claudeSonnetModel"
                    class="max-w-full text-xs font-mono bg-surface-800 text-gray-300 border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-cyan/50 cursor-pointer"
                  >
                    <template x-for="m in claudeModelsSonnet" :key="m">
                      <option :value="m" x-text="m" :disabled="m === modelPickerSeparator"></option>
                    </template>
                  </select>
                </div>
                <div class="flex min-w-0 items-center gap-2">
                  <label class="text-xs text-gray-500">Haiku:</label>
                  <select
                    x-model="claudeSmallModel"
                    class="max-w-full text-xs font-mono bg-surface-800 text-gray-300 border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-cyan/50 cursor-pointer"
                  >
                    <template x-for="m in claudeModelsSmall" :key="m">
                      <option :value="m" x-text="m" :disabled="m === modelPickerSeparator"></option>
                    </template>
                  </select>
                </div>
              </div>

              <p class="text-[11px] text-gray-600 mb-2">Add to <code class="text-gray-500">~/.bashrc</code>, <code class="text-gray-500">~/.zshrc</code>, or equivalent</p>
              ${codeBlock('bash', 'claudeCode', 'claudeCodeSnippet', 'claude')}
            </div>

            <div>
              <div class="mb-3">
                <span class="text-sm font-semibold text-white">Codex</span>
              </div>

              <div class="flex min-w-0 items-center gap-2 mb-3">
                <label class="text-xs text-gray-500">Model:</label>
                <select
                  x-model="codexModel"
                  class="max-w-full text-xs font-mono bg-surface-800 text-gray-300 border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-cyan/50 cursor-pointer"
                >
                  <template x-for="m in codexModels" :key="m">
                    <option :value="m" x-text="m" :disabled="m === modelPickerSeparator"></option>
                  </template>
                </select>
              </div>

              <p class="text-[11px] text-gray-600 mb-2">Add to <code class="text-gray-500">~/.codex/config.toml</code></p>
              ${codeBlock('toml', 'codexCode', 'codexSnippet', 'codex')}

              <p class="text-[11px] text-gray-600 mt-4 mb-2">Add to <code class="text-gray-500">~/.bashrc</code>, <code class="text-gray-500">~/.zshrc</code>, or equivalent</p>
              ${codeBlock('bash', 'codexEnv', 'codexEnvSnippet', 'codexEnv')}
            </div>
          </div>
        </template>
      </div>
    </div>
  `;
}

export function renderUsageTab() {
  return html`
    <div x-show="tab === 'usage'">
      <div class="glass-card p-6 animate-in">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div class="flex items-center gap-3">
            <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Token Usage — By Key</span>
            <button
              @click="toggleRedactKeys()"
              class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md p-1 transition-colors text-gray-600 hover:text-gray-400 hover:bg-white/[0.04]"
              aria-label="Toggle key name redaction"
              title="Redact key names"
            >
              <svg x-show="!redactKeys" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <svg x-show="redactKeys" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            </button>
            <template x-if="tokenLoading"> ${spinner('h-3.5 w-3.5 text-gray-500')} </template>
          </div>
          <div class="flex max-w-full items-center gap-1 overflow-x-auto bg-surface-800 rounded-lg p-0.5">
            <button
              @click="switchTokenRange('today')"
              class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="tokenRange === 'today' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
            >
              Last Day
            </button>
            <button
              @click="switchTokenRange('7d')"
              class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="tokenRange === '7d' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
            >
              7 Days
            </button>
            <button
              @click="switchTokenRange('30d')"
              class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
              :class="tokenRange === '30d' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
            >
              30 Days
            </button>
          </div>
        </div>

        <div style="height: 320px; position: relative;">
          <template x-if="tokenLoading && !chartsReady">
            <div class="absolute inset-0 flex items-center justify-center">
              <div class="flex flex-col items-center gap-3">
                ${spinner('h-6 w-6 text-accent-cyan/60')}
                <span class="text-xs text-gray-500">Loading usage data…</span>
              </div>
            </div>
          </template>
          <canvas id="tokenChartByKey"></canvas>
        </div>

        <div class="mt-6 pt-5 border-t border-white/5">
          <span class="text-xs font-medium text-gray-500 uppercase tracking-widest mb-4 block">By Model</span>
          <div style="height: 320px; position: relative;">
            <template x-if="tokenLoading && !chartsReady">
              <div class="absolute inset-0 flex items-center justify-center">
                <div class="flex flex-col items-center gap-3">
                  ${spinner('h-6 w-6 text-accent-cyan/60')}
                  <span class="text-xs text-gray-500">Loading usage data…</span>
                </div>
              </div>
            </template>
            <canvas id="tokenChartByModel"></canvas>
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mt-6 pt-5 border-t border-white/5">
          ${usageSummaryMetricPair(
            usageSummaryMetric('requests', 'Requests', 'tokenSummary.requests.toLocaleString()', 'w-16'),
            usageSummaryMetric(
              'cost',
              'Est. Cost',
              "tokenSummary.cost >= 1 ? '$' + tokenSummary.cost.toFixed(2) : tokenSummary.cost >= 0.01 ? '$' + tokenSummary.cost.toFixed(3) : tokenSummary.cost > 0 ? '$' + tokenSummary.cost.toFixed(4) : '$0'",
              'w-20',
            ),
          )}
          ${usageSummaryMetricPair(
            usageSummaryMetric('total', 'Total Tokens', 'tokenSummary.total.toLocaleString()', 'w-20'),
            usageSummaryMetric('output', 'Output Tokens', 'tokenSummary.output.toLocaleString()', 'w-20'),
          )}
          ${usageSummaryMetricPair(
            usageSummaryMetric('input', 'Input Tokens', 'tokenSummary.input.toLocaleString()', 'w-20'),
            usageSummaryMetric('prefill', 'Prefill Input', 'tokenSummary.prefill.toLocaleString()', 'w-20'),
          )}
          ${usageSummaryMetricPair(
            usageSummaryMetric('cached', 'Cached Input', 'tokenSummary.cacheRead.toLocaleString()', 'w-20'),
            usageSummaryMetric('cachedRate', 'Cached Rate', 'formatInputRate(tokenSummary.cacheRead, tokenSummary.input)', 'w-20'),
          )}
          ${usageSummaryMetricPair(
            usageSummaryMetric('cacheCreation', 'Cache Write', 'tokenSummary.cacheCreation.toLocaleString()', 'w-20'),
            usageSummaryMetric('cacheHitRate', 'Cache Hit Rate', 'formatHitRate(tokenSummary.cacheRead, tokenSummary.cacheCreation)', 'w-20'),
          )}
        </div>

        <div x-show="searchUsageActiveProvider !== 'disabled'" class="mt-6 pt-5 border-t border-white/5">
          <div class="flex items-center gap-3 mb-4">
            <span class="text-xs font-medium text-gray-500 uppercase tracking-widest block">Search Usage — Per Key</span>
            <template x-if="searchUsageLoading"> ${spinner('h-3.5 w-3.5 text-gray-500')} </template>
          </div>
          <div style="height: 320px; position: relative;">
            <template x-if="searchUsageLoading && !chartsReady">
              <div class="absolute inset-0 flex items-center justify-center">
                <div class="flex flex-col items-center gap-3">
                  ${spinner('h-6 w-6 text-accent-cyan/60')}
                  <span class="text-xs text-gray-500">Loading usage data…</span>
                </div>
              </div>
            </template>
            <canvas id="searchUsageChartByKey"></canvas>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderPerformanceTab() {
  return html`
    <div x-show="tab === 'performance'">
      <div class="glass-card p-6 animate-in">
        <div class="flex flex-col gap-4 mb-6 lg:flex-row lg:items-center lg:justify-between">
          <div class="flex items-center gap-3">
            <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Performance</span>
            <template x-if="performanceLoading"> ${spinner('h-3.5 w-3.5 text-gray-500')} </template>
          </div>
          <div class="flex max-w-full flex-wrap items-center gap-2">
            <div class="flex max-w-full items-center gap-1 overflow-x-auto bg-surface-800 rounded-lg p-0.5">
              <button
                @click="switchPerformanceMetricScope('request_total')"
                class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="performanceMetricScope === 'request_total' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              >
                Total
              </button>
              <button
                @click="switchPerformanceMetricScope('upstream_success')"
                class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="performanceMetricScope === 'upstream_success' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              >
                Upstream
              </button>
            </div>
            <div class="flex max-w-full items-center gap-1 overflow-x-auto bg-surface-800 rounded-lg p-0.5">
              <button
                @click="switchPerformanceChartView('model')"
                class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="performanceChartView === 'model' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              >
                By Model
              </button>
              <button
                @click="switchPerformanceChartView('percentile')"
                class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="performanceChartView === 'percentile' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              >
                By Percentile
              </button>
            </div>
            <div x-show="performanceChartView === 'model'" class="flex max-w-full items-center gap-1 overflow-x-auto bg-surface-800 rounded-lg p-0.5">
              <button
                @click="switchPerformancePercentile('p50Ms')"
                class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="performancePercentile === 'p50Ms' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              >
                p50
              </button>
              <button
                @click="switchPerformancePercentile('p95Ms')"
                class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="performancePercentile === 'p95Ms' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              >
                p95
              </button>
              <button
                @click="switchPerformancePercentile('p99Ms')"
                class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="performancePercentile === 'p99Ms' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              >
                p99
              </button>
            </div>
            <div x-show="performanceChartView === 'percentile'" class="flex max-w-full items-center gap-1 overflow-x-auto bg-surface-800 rounded-lg p-0.5">
              <select
                x-model="performanceModel"
                @change="renderPerformanceChart()"
                class="shrink-0 min-w-44 max-w-64 rounded-md bg-surface-600 px-3 py-1.5 text-xs font-medium text-white outline-none"
                aria-label="Performance model"
              >
                <template x-for="model in performanceModelOptions()" :key="model">
                  <option :value="model" x-text="model"></option>
                </template>
              </select>
            </div>
            <div class="flex max-w-full items-center gap-1 overflow-x-auto bg-surface-800 rounded-lg p-0.5">
              <button
                @click="switchPerformanceRange('today')"
                class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="performanceRange === 'today' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              >
                Last Day
              </button>
              <button
                @click="switchPerformanceRange('7d')"
                class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="performanceRange === '7d' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              >
                7 Days
              </button>
              <button
                @click="switchPerformanceRange('30d')"
                class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                :class="performanceRange === '30d' ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
              >
                30 Days
              </button>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3 mb-6 lg:grid-cols-6">
          <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
            <span class="block text-xs text-gray-500 mb-1">Successful</span>
            <span class="block text-lg font-bold font-mono text-white" x-text="performanceSummary.requests.toLocaleString()"></span>
          </div>
          <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
            <span class="block text-xs text-gray-500 mb-1">Errors</span>
            <span class="block text-lg font-bold font-mono text-white" x-text="performanceSummary.errors.toLocaleString()"></span>
          </div>
          <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
            <span class="block text-xs text-gray-500 mb-1">Average</span>
            <span class="block text-lg font-bold font-mono text-white" x-text="formatDuration(performanceSummary.avgMs)"></span>
          </div>
          <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
            <span class="block text-xs text-gray-500 mb-1">p50</span>
            <span class="block text-lg font-bold font-mono text-white" x-text="formatDuration(performanceSummary.p50Ms)"></span>
          </div>
          <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
            <span class="block text-xs text-gray-500 mb-1">p95</span>
            <span class="block text-lg font-bold font-mono text-white" x-text="formatDuration(performanceSummary.p95Ms)"></span>
          </div>
          <div class="rounded-md border border-white/5 bg-surface-800/60 px-3 py-3">
            <span class="block text-xs text-gray-500 mb-1">p99</span>
            <span class="block text-lg font-bold font-mono text-white" x-text="formatDuration(performanceSummary.p99Ms)"></span>
          </div>
        </div>

        <div style="height: 340px; position: relative;">
          <template x-if="performanceLoading && !chartsReady">
            <div class="absolute inset-0 flex items-center justify-center">
              <div class="flex flex-col items-center gap-3">
                ${spinner('h-6 w-6 text-accent-cyan/60')}
                <span class="text-xs text-gray-500">Loading performance data…</span>
              </div>
            </div>
          </template>
          <canvas id="performanceChartByModel"></canvas>
        </div>

        <div class="grid grid-cols-1 gap-5 mt-6 pt-5 border-t border-white/5 lg:grid-cols-2">
          <div>
            <span class="text-xs font-medium text-gray-500 uppercase tracking-widest mb-3 block">By Model</span>
            <div class="overflow-x-auto rounded-md border border-white/5">
              <table class="w-full text-sm">
                <thead class="bg-surface-800/70 text-xs uppercase tracking-widest text-gray-500">
                  <tr>
                    <th class="px-3 py-2 text-left font-medium">Model</th>
                    <th class="px-3 py-2 text-right font-medium">Req</th>
                    <th class="px-3 py-2 text-right font-medium" x-text="performancePercentileLabel()"></th>
                    <th class="px-3 py-2 text-right font-medium">Avg</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-white/5">
                  <template x-for="row in performanceModelRows" :key="row.group">
                    <tr>
                      <td class="px-3 py-2 text-gray-300" x-text="row.group"></td>
                      <td class="px-3 py-2 text-right font-mono text-gray-400" x-text="row.requests.toLocaleString()"></td>
                      <td class="px-3 py-2 text-right font-mono text-white" x-text="formatDuration(row[performancePercentile])"></td>
                      <td class="px-3 py-2 text-right font-mono text-gray-400" x-text="formatDuration(row.avgMs)"></td>
                    </tr>
                  </template>
                </tbody>
              </table>
            </div>
          </div>
          <div x-show="performanceRuntimeRows.length > 0">
            <span class="text-xs font-medium text-gray-500 uppercase tracking-widest mb-3 block">By Region</span>
            <div class="overflow-x-auto rounded-md border border-white/5">
              <table class="w-full text-sm">
                <thead class="bg-surface-800/70 text-xs uppercase tracking-widest text-gray-500">
                  <tr>
                    <th class="px-3 py-2 text-left font-medium">Region</th>
                    <th class="px-3 py-2 text-right font-medium">Req</th>
                    <th class="px-3 py-2 text-right font-medium" x-text="performancePercentileLabel()"></th>
                    <th class="px-3 py-2 text-right font-medium">Avg</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-white/5">
                  <template x-for="row in performanceRuntimeRows" :key="row.group">
                    <tr>
                      <td class="px-3 py-2 text-gray-300" x-text="row.group"></td>
                      <td class="px-3 py-2 text-right font-mono text-gray-400" x-text="row.requests.toLocaleString()"></td>
                      <td class="px-3 py-2 text-right font-mono text-white" x-text="formatDuration(row[performancePercentile])"></td>
                      <td class="px-3 py-2 text-right font-mono text-gray-400" x-text="formatDuration(row.avgMs)"></td>
                    </tr>
                  </template>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderSettingsTab() {
  return html`
    <template x-if="isAdmin">
      <div x-show="tab === 'settings'" x-transition:enter="transition ease-out duration-200" x-transition:enter-start="opacity-0" x-transition:enter-end="opacity-100">
        <template x-if="meLoaded && githubAccounts.length === 0">
          <div class="glass-card p-5 sm:p-6 mb-5 glow-border animate-in flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div class="min-w-0">
              <h3 class="text-white font-medium mb-1">Connect GitHub Account</h3>
              <p class="text-sm text-gray-400">Link your GitHub account to use Copilot API with your own token.</p>
            </div>
            <button @click="startGithubAuth()" class="btn-primary w-full sm:w-auto" :disabled="deviceFlow.loading">
              <span x-show="!deviceFlow.loading">Connect GitHub</span>
              <span x-show="deviceFlow.loading" class="flex items-center gap-2"> ${spinner('h-4 w-4')} Connecting… </span>
            </button>
          </div>
        </template>

        <template x-if="deviceFlow.userCode">
          <div class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-in overflow-y-auto p-4">
            <div class="glass-card p-6 sm:p-8 max-w-md w-full glow-cyan">
              <h3 class="text-white text-lg font-semibold mb-2">GitHub Authorization</h3>
              <p class="text-gray-400 text-sm mb-6">Enter this code on GitHub to authorize:</p>

              <div class="bg-surface-900 rounded-xl p-6 text-center mb-6 glow-border">
                <code class="block text-2xl sm:text-3xl font-mono font-bold text-accent-cyan tracking-[0.2em] sm:tracking-[0.3em] break-all" x-text="deviceFlow.userCode"></code>
              </div>

              <p class="text-gray-500 text-xs text-center mb-2">
                Visit <a :href="deviceFlow.verificationUri" class="text-accent-cyan hover:underline break-all" x-text="deviceFlow.verificationUri" target="_blank"></a>
              </p>
              <a :href="deviceFlow.verificationUri" target="_blank" class="btn-primary w-full block text-center mb-4"> Open GitHub </a>

              <div class="flex items-center justify-center gap-2 text-sm text-gray-500">${spinner('h-4 w-4')} Waiting for authorization...</div>

              <button @click="cancelDeviceFlow()" class="btn-ghost w-full mt-4">Cancel</button>
            </div>
          </div>
        </template>

        <template x-if="upstreamModal.open">
          <div class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 animate-in overflow-y-auto">
            <div class="flex min-h-full items-start justify-center p-4 sm:items-center">
              <div class="glass-card p-6 sm:p-8 max-w-lg w-full glow-cyan my-auto">
                <h3 class="text-white text-lg font-semibold mb-4" x-text="upstreamModal.id ? 'Edit Upstream' : 'Add Upstream'"></h3>

                <div class="space-y-4">
                  <div>
                    <label class="block text-xs font-medium text-gray-500 uppercase tracking-widest mb-2">Name</label>
                    <input type="text" class="w-full" placeholder="e.g. OpenAI Production" x-model="upstreamModal.name" />
                  </div>
                  <div>
                    <label class="block text-xs font-medium text-gray-500 uppercase tracking-widest mb-2">Base URL</label>
                    <input type="text" class="w-full font-mono text-sm" placeholder="https://api.openai.com" x-model="upstreamModal.baseUrl" />
                    <p class="text-[11px] text-gray-600 mt-1">Final URL is base + path. Override individual paths below if your provider mounts the API under a subpath.</p>
                  </div>
                  <div>
                    <label class="block text-xs font-medium text-gray-500 uppercase tracking-widest mb-2">
                      <span x-text="upstreamModal.id ? 'Bearer Token (leave blank to keep)' : 'Bearer Token'"></span>
                    </label>
                    <input type="password" autocomplete="off" class="w-full font-mono text-sm" placeholder="sk-..." x-model="upstreamModal.bearerToken" />
                  </div>
                  <div>
                    <label class="block text-xs font-medium text-gray-500 uppercase tracking-widest mb-2">Supported Endpoints</label>
                    <div class="space-y-2">
                      <template x-for="ep in ['/chat/completions','/responses','/v1/messages','/embeddings']" :key="ep">
                        <label class="flex items-center gap-2 text-sm text-gray-300">
                          <input type="checkbox" class="accent-accent-cyan" :checked="upstreamModal.supportedEndpoints.includes(ep)" @change="toggleUpstreamEndpoint(ep)" />
                          <span class="font-mono" x-text="ep"></span>
                        </label>
                      </template>
                    </div>
                  </div>
                  <div>
                    <button
                      type="button"
                      @click="upstreamModal.enabledFixesOpen = !upstreamModal.enabledFixesOpen"
                      :aria-expanded="upstreamModal.enabledFixesOpen.toString()"
                      class="flex w-full items-center justify-between text-left text-xs font-medium text-gray-500 uppercase tracking-widest mb-2 hover:text-gray-300 transition-colors"
                    >
                      <span>Enabled Fixes</span>
                      <span class="flex items-center gap-2 normal-case tracking-normal text-[10px] text-gray-600">
                        <span x-show="!upstreamModal.enabledFixesOpen && upstreamModal.enabledFixes.length > 0" x-text="upstreamModal.enabledFixes.length + ' enabled'"></span>
                        <svg class="h-3 w-3 transition-transform" :class="upstreamModal.enabledFixesOpen ? 'rotate-180' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </span>
                    </button>
                    <div x-show="upstreamModal.enabledFixesOpen" x-cloak>
                      <p x-show="upstreamFixCatalog.length === 0" class="text-[11px] text-gray-600">No opt-in upstream behavior flags are registered.</p>
                      <div x-show="upstreamFixCatalog.length > 0" class="max-h-72 overflow-y-auto rounded-lg border border-white/10 bg-surface-700/40 p-3 space-y-2">
                        <template x-for="fix in upstreamFixCatalog" :key="fix.id">
                          <label class="flex items-start gap-2 text-sm text-gray-300">
                            <input type="checkbox" class="accent-accent-cyan mt-0.5" :checked="upstreamModal.enabledFixes.includes(fix.id)" @change="toggleUpstreamFix(fix.id)" />
                            <span class="flex-1">
                              <span class="font-mono text-xs text-white" x-text="fix.label || fix.id"></span>
                              <span x-show="fix.description" class="block text-[11px] text-gray-500 mt-0.5" x-text="fix.description"></span>
                            </span>
                          </label>
                        </template>
                      </div>
                    </div>
                  </div>
                  <div>
                    <button
                      type="button"
                      @click="upstreamModal.pathOverridesOpen = !upstreamModal.pathOverridesOpen"
                      :aria-expanded="upstreamModal.pathOverridesOpen.toString()"
                      class="flex w-full items-center justify-between text-left text-xs font-medium text-gray-500 uppercase tracking-widest mb-2 hover:text-gray-300 transition-colors"
                    >
                      <span>Path Overrides</span>
                      <span class="flex items-center gap-2 normal-case tracking-normal text-[10px] text-gray-600">
                        <span x-show="!upstreamModal.pathOverridesOpen && upstreamModalOverrideCount() > 0" x-text="upstreamModalOverrideCount() + ' set'"></span>
                        <svg class="h-3 w-3 transition-transform" :class="upstreamModal.pathOverridesOpen ? 'rotate-180' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </span>
                    </button>
                    <div x-show="upstreamModal.pathOverridesOpen" x-cloak>
                      <p class="text-[11px] text-gray-600 mb-2">
                        Leave blank to use the OpenAI default
                        <code class="font-mono">/v1/&lt;endpoint&gt;</code>.
                        <code class="font-mono">/v1/messages/count_tokens</code>
                        follows the messages path automatically.
                      </p>
                      <div class="space-y-2">
                        <template x-for="key in ['chat_completions','responses','messages','embeddings','models']" :key="key">
                          <div class="flex items-center gap-2">
                            <span class="font-mono text-xs text-gray-500 w-32 shrink-0" x-text="key"></span>
                            <input type="text" class="flex-1 font-mono text-xs" :placeholder="'/v1/' + key.replace('_', '/')" x-model="upstreamModal.pathOverrides[key]" />
                          </div>
                        </template>
                      </div>
                    </div>
                  </div>
                  <div class="flex items-center justify-between gap-3 flex-wrap">
                    <label class="flex items-center gap-2 text-sm text-gray-300">
                      <input type="checkbox" class="accent-accent-cyan" x-model="upstreamModal.enabled" />
                      Enabled
                    </label>
                    <label class="flex items-center gap-2 text-sm text-gray-300">
                      Order
                      <input type="number" class="w-20" x-model.number="upstreamModal.sortOrder" />
                    </label>
                  </div>
                  <template x-if="upstreamModal.error">
                    <p class="text-sm text-red-300" x-text="upstreamModal.error"></p>
                  </template>
                </div>

                <div class="flex flex-col sm:flex-row gap-2 mt-6">
                  <button @click="saveUpstream()" class="btn-primary flex-1" :disabled="upstreamModal.saving">
                    <span x-show="!upstreamModal.saving">Save</span>
                    <span x-show="upstreamModal.saving" class="flex items-center justify-center gap-2"> ${spinner('h-4 w-4')} Saving… </span>
                  </button>
                  <button @click="closeUpstreamModal()" class="btn-ghost">Cancel</button>
                </div>
              </div>
            </div>
          </div>
        </template>

        <div class="glass-card p-5 sm:p-6 mb-5 animate-in delay-3">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-4">
            <div class="min-w-0">
              <h3 class="text-white font-semibold mb-1">Custom Upstreams</h3>
              <p class="text-sm text-gray-400">Route requests to OpenAI-compatible APIs alongside (or instead of) GitHub Copilot.</p>
            </div>
            <button @click="openUpstreamModal()" class="btn-ghost text-xs self-start sm:self-auto">+ Add Upstream</button>
          </div>

          <template x-if="!upstreamsLoaded">
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div class="h-12 bg-surface-600 rounded animate-pulse"></div>
              <div class="h-12 bg-surface-600 rounded animate-pulse"></div>
            </div>
          </template>

          <template x-if="upstreamsLoaded && upstreams.length === 0">
            <p class="text-sm text-gray-500">No custom upstreams configured. Requests fall back to GitHub Copilot.</p>
          </template>

          <template x-if="upstreamsLoaded && upstreams.length > 0">
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <template x-for="up in upstreams" :key="up.id">
                <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-lg border border-white/5 bg-surface-800 p-3">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 mb-1 flex-wrap">
                      <span class="w-2 h-2 rounded-full shrink-0" :class="up.enabled ? 'bg-accent-emerald' : 'bg-gray-600'"></span>
                      <p class="text-sm font-medium text-white truncate" x-text="up.name"></p>
                      <span class="text-[10px] text-gray-500 font-mono" x-text="'sort: ' + up.sort_order"></span>
                      <span
                        x-show="up.enabled_fixes && up.enabled_fixes.length > 0"
                        class="text-[10px] uppercase tracking-widest text-accent-amber font-mono"
                        x-text="up.enabled_fixes.length + ' fix' + (up.enabled_fixes.length === 1 ? '' : 'es')"
                      ></span>
                    </div>
                    <p class="text-xs text-gray-500 font-mono truncate" x-text="up.base_url"></p>
                    <p class="text-[11px] text-gray-600 mt-1">
                      <span x-text="up.supported_endpoints.join(', ')"></span>
                    </p>
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    <button @click="testUpstream(up.id)" class="btn-ghost text-xs" :disabled="upstreamTestingId === up.id">
                      <span x-show="upstreamTestingId !== up.id">Test</span>
                      <span x-show="upstreamTestingId === up.id" class="flex items-center gap-1"> ${spinner('h-3 w-3')} Testing </span>
                    </button>
                    <button @click="openUpstreamModal(up)" class="btn-ghost text-xs">Edit</button>
                    <button
                      @click="deleteUpstream(up.id, up.name)"
                      class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-gray-600 hover:text-accent-rose hover:bg-white/[0.04] transition-colors p-1"
                      aria-label="Delete upstream"
                      title="Delete"
                    >
                      <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                </div>
              </template>
            </div>
          </template>

          <template x-if="upstreamTestResult">
            <div class="rounded-lg border p-3 mt-3" :class="upstreamTestResult.ok ? 'border-accent-emerald/20 bg-accent-emerald/5' : 'border-red-500/20 bg-red-500/5'">
              <p
                class="text-xs font-medium mb-1"
                :class="upstreamTestResult.ok ? 'text-accent-emerald' : 'text-red-300'"
                x-text="upstreamTestResult.ok ? ('OK · ' + upstreamTestResult.model_count + ' models') : ('Error · status ' + (upstreamTestResult.status ?? 'n/a'))"
              ></p>
              <p
                class="text-[11px] text-gray-400 break-all"
                x-text="upstreamTestResult.ok ? upstreamTestResult.models.slice(0, 8).join(', ') + (upstreamTestResult.models.length > 8 ? '…' : '') : (upstreamTestResult.body ?? upstreamTestResult.error ?? '')"
              ></p>
            </div>
          </template>
        </div>

        <div class="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div class="flex flex-col gap-5">
            <div class="glass-card p-5 sm:p-6 animate-in">
              <div class="flex items-center justify-between mb-4">
                <h3 class="text-white font-semibold">GitHub Accounts</h3>
                <template x-if="meLoaded && githubAccounts.length > 0">
                  <button @click="startGithubAuth()" class="btn-ghost text-xs" :disabled="deviceFlow.loading">
                    <span x-show="!deviceFlow.loading">+ Add</span>
                    <span x-show="deviceFlow.loading" class="flex items-center gap-1.5"> ${spinner('h-3 w-3')} Adding… </span>
                  </button>
                </template>
              </div>
              <template x-if="!meLoaded">
                <div class="space-y-3">
                  <div class="flex items-center gap-3">
                    <div class="w-9 h-9 rounded-lg bg-surface-600 animate-pulse shrink-0"></div>
                    <div class="space-y-1.5 flex-1">
                      <div class="h-4 w-28 bg-surface-600 rounded animate-pulse"></div>
                      <div class="h-3 w-20 bg-surface-600 rounded animate-pulse"></div>
                    </div>
                  </div>
                </div>
              </template>
              <template x-if="meLoaded && githubAccounts.length === 0">
                <p class="text-sm text-gray-500">No GitHub accounts connected</p>
              </template>
              <template x-if="meLoaded && githubAccounts.length > 0">
                <div class="space-y-1">
                  <template x-for="(acct, index) in githubAccounts" :key="acct.id">
                    <div
                      @click="selectGithubAccount(acct.id)"
                      class="rounded-lg px-3 py-2.5 transition-colors"
                      :class="selectedGithubAccountId === acct.id ? 'bg-accent-cyan/5 border border-accent-cyan/15' : 'hover:bg-white/[0.03] cursor-pointer border border-transparent'"
                    >
                      <div class="flex flex-col gap-3 sm:flex-row sm:items-start">
                        <div class="flex min-w-0 flex-1 items-start gap-3">
                          <img :src="acct.avatar_url" class="w-9 h-9 shrink-0 rounded-lg ring-1 ring-white/5" />
                          <div class="min-w-0 flex-1">
                            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <p class="min-w-0 truncate text-sm text-white font-medium" x-text="acct.name || acct.login"></p>
                            </div>
                            <p class="text-xs text-gray-500 truncate" x-text="'@' + acct.login"></p>
                          </div>
                        </div>
                        <div class="flex w-full shrink-0 items-center justify-end gap-1 border-t border-white/[0.04] pt-2 sm:w-auto sm:border-t-0 sm:pt-0 sm:gap-1.5">
                          <button
                            @click.stop="moveGithubAccount(acct.id, -1)"
                            class="inline-flex min-h-8 min-w-8 items-center justify-center rounded-md text-gray-600 hover:text-accent-cyan hover:bg-white/[0.04] transition-colors p-1 disabled:opacity-30 disabled:hover:text-gray-600 disabled:hover:bg-transparent sm:min-h-9 sm:min-w-9"
                            :disabled="index === 0"
                            aria-label="Move account up"
                            title="Move up"
                          >
                            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <polyline points="18 15 12 9 6 15" />
                            </svg>
                          </button>
                          <button
                            @click.stop="moveGithubAccount(acct.id, 1)"
                            class="inline-flex min-h-8 min-w-8 items-center justify-center rounded-md text-gray-600 hover:text-accent-cyan hover:bg-white/[0.04] transition-colors p-1 disabled:opacity-30 disabled:hover:text-gray-600 disabled:hover:bg-transparent sm:min-h-9 sm:min-w-9"
                            :disabled="index === githubAccounts.length - 1"
                            aria-label="Move account down"
                            title="Move down"
                          >
                            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <polyline points="6 9 12 15 18 9" />
                            </svg>
                          </button>
                          <button
                            @click.stop="disconnectGithub(acct.id, acct.login)"
                            class="inline-flex min-h-8 min-w-8 items-center justify-center rounded-md text-gray-600 hover:text-accent-rose hover:bg-white/[0.04] transition-colors p-1 sm:min-h-9 sm:min-w-9"
                            aria-label="Disconnect GitHub account"
                            title="Disconnect"
                          >
                            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  </template>
                </div>
              </template>

              <div class="mt-4 border-t border-white/[0.05] pt-4">
                <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div class="min-w-0">
                    <h3 class="flex min-w-0 max-w-full items-baseline font-semibold">
                      <span class="shrink-0 text-white">Copilot Quota</span>
                      <span
                        class="ml-1 min-w-0 truncate text-gray-500"
                        x-text="selectedGithubAccountId ? '· @' + (githubAccounts.find((acct) => acct.id === selectedGithubAccountId)?.login || 'selected') : '· none'"
                      ></span>
                    </h3>
                    <template x-if="usageData">
                      <p class="text-xs text-gray-500 mt-0.5"><span x-text="usageData.copilot_plan"></span> · Resets <span x-text="formatDate(usageData.quota_reset_date)"></span></p>
                    </template>
                  </div>
                  <template x-if="usageData">
                    <div class="shrink-0 sm:text-right">
                      <p class="font-mono text-2xl font-bold text-white">
                        <span x-text="usageData.quota_snapshots.premium_interactions.entitlement - usageData.quota_snapshots.premium_interactions.remaining"></span>
                        <span class="mx-1 text-gray-500">/</span>
                        <span x-text="usageData.quota_snapshots.premium_interactions.entitlement"></span>
                      </p>
                      <p class="text-xs text-gray-500 mt-0.5">premium requests used</p>
                    </div>
                  </template>
                </div>

                <template x-if="usageData">
                  <div class="mt-3">
                    <div class="progress-track">
                      <div
                        class="progress-fill"
                        :class="usagePercent > 90 ? 'bg-accent-rose' : usagePercent > 70 ? 'bg-gradient-to-r from-accent-amber to-accent-rose' : 'bg-gradient-to-r from-accent-cyan to-accent-emerald'"
                        :style="'width:' + usagePercent + '%'"
                      ></div>
                    </div>
                    <div class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <div class="rounded-lg border border-white/5 bg-white/[0.03] p-3">
                        <p class="text-[11px] uppercase tracking-widest text-gray-500">Premium Remaining</p>
                        <p class="mt-1 font-mono text-sm font-semibold text-white" x-text="usageData.quota_snapshots.premium_interactions.remaining"></p>
                      </div>
                      <div class="rounded-lg border border-white/5 bg-white/[0.03] p-3">
                        <p class="text-[11px] uppercase tracking-widest text-gray-500">Chat</p>
                        <p class="mt-1 font-mono text-sm font-semibold text-white">
                          <span x-text="usageData.quota_snapshots.chat.unlimited ? '\\u221e unlimited' : usageData.quota_snapshots.chat.remaining"></span>
                        </p>
                      </div>
                      <div class="rounded-lg border border-white/5 bg-white/[0.03] p-3">
                        <p class="text-[11px] uppercase tracking-widest text-gray-500">Completions</p>
                        <p class="mt-1 font-mono text-sm font-semibold text-white">
                          <span x-text="usageData.quota_snapshots.completions.unlimited ? '\\u221e unlimited' : usageData.quota_snapshots.completions.remaining"></span>
                        </p>
                      </div>
                    </div>
                  </div>
                </template>
                <template x-if="!usageData && !usageError">
                  <div class="mt-3 space-y-2">
                    <div class="h-2 bg-surface-600 rounded animate-pulse"></div>
                    <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <div class="h-16 bg-surface-600 rounded-lg animate-pulse"></div>
                      <div class="h-16 bg-surface-600 rounded-lg animate-pulse"></div>
                      <div class="h-16 bg-surface-600 rounded-lg animate-pulse"></div>
                    </div>
                  </div>
                </template>
                <template x-if="usageError">
                  <p class="mt-3 text-sm text-gray-500">Unable to load quota</p>
                </template>
              </div>
            </div>

            <div class="glass-card p-5 sm:p-6 animate-in delay-2">
              <div class="mb-4">
                <h3 class="text-white font-semibold mb-1">Web Search</h3>
                <p class="text-sm text-gray-400">Configure the search provider used by Anthropic Messages web search.</p>
              </div>

              <template x-if="!searchConfigLoaded">
                <div class="space-y-4">
                  <div class="flex items-center gap-2 text-xs text-gray-500">
                    ${spinner('h-3.5 w-3.5 text-gray-500')}
                    <span>Loading saved search config...</span>
                  </div>
                  <div class="grid grid-cols-1 gap-3">
                    <div class="h-20 rounded-xl bg-surface-600 animate-pulse"></div>
                    <div class="h-20 rounded-xl bg-surface-600 animate-pulse"></div>
                    <div class="h-20 rounded-xl bg-surface-600 animate-pulse"></div>
                  </div>
                  <div class="space-y-2">
                    <div class="h-4 w-32 bg-surface-600 rounded animate-pulse"></div>
                    <div class="h-11 bg-surface-600 rounded-lg animate-pulse"></div>
                  </div>
                </div>
              </template>

              <template x-if="searchConfigLoaded">
                <div class="space-y-5">
                  <div>
                    <p class="text-xs font-medium text-gray-500 uppercase tracking-widest mb-3">Search Provider</p>
                    <div class="grid grid-cols-1 gap-3">
                      <label
                        class="flex items-center gap-3 rounded-xl border p-4 transition-all cursor-pointer"
                        :class="searchConfigDraft.provider === 'disabled' ? 'border-accent-cyan/50 bg-accent-cyan/5' : 'border-white/10 hover:border-white/20'"
                      >
                        <input
                          type="radio"
                          name="search-provider"
                          value="disabled"
                          class="accent-accent-cyan"
                          :checked="searchConfigDraft.provider === 'disabled'"
                          :disabled="!searchConfigLoaded"
                          @change="setSearchConfigProvider('disabled')"
                        />
                        <div>
                          <p class="text-sm font-medium text-white">Disabled</p>
                          <p class="text-xs text-gray-500">No upstream web search provider</p>
                        </div>
                      </label>

                      <label
                        class="flex items-center gap-3 rounded-xl border p-4 transition-all cursor-pointer"
                        :class="searchConfigDraft.provider === 'tavily' ? 'border-accent-cyan/50 bg-accent-cyan/5' : 'border-white/10 hover:border-white/20'"
                      >
                        <input
                          type="radio"
                          name="search-provider"
                          value="tavily"
                          class="accent-accent-cyan"
                          :checked="searchConfigDraft.provider === 'tavily'"
                          :disabled="!searchConfigLoaded"
                          @change="setSearchConfigProvider('tavily')"
                        />
                        <div>
                          <p class="text-sm font-medium text-white">Tavily</p>
                          <p class="text-xs text-gray-500">Gateway-managed Tavily API key</p>
                        </div>
                      </label>

                      <label
                        class="flex items-center gap-3 rounded-xl border p-4 transition-all cursor-pointer"
                        :class="searchConfigDraft.provider === 'microsoft-grounding' ? 'border-accent-cyan/50 bg-accent-cyan/5' : 'border-white/10 hover:border-white/20'"
                      >
                        <input
                          type="radio"
                          name="search-provider"
                          value="microsoft-grounding"
                          class="accent-accent-cyan"
                          :checked="searchConfigDraft.provider === 'microsoft-grounding'"
                          :disabled="!searchConfigLoaded"
                          @change="setSearchConfigProvider('microsoft-grounding')"
                        />
                        <div>
                          <p class="text-sm font-medium text-white">Microsoft Grounding</p>
                          <p class="text-xs text-gray-500">Gateway-managed Microsoft Grounding key</p>
                        </div>
                      </label>
                    </div>
                  </div>

                  <div>
                    <label class="block text-xs font-medium text-gray-500 uppercase tracking-widest mb-2" x-text="searchCredentialLabel"></label>
                    <input
                      type="password"
                      autocomplete="off"
                      :placeholder="searchConfigDraft.provider === 'tavily' ? 'Tavily API key' : searchConfigDraft.provider === 'microsoft-grounding' ? 'Microsoft Grounding API key' : 'No credential needed when disabled'"
                      :value="searchCredentialValue"
                      @input="setSearchCredentialValue($event.target.value)"
                      :disabled="!searchConfigLoaded || searchConfigDraft.provider === 'disabled'"
                      class="w-full"
                    />
                  </div>

                  <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                    <button @click="saveSearchConfig()" class="btn-primary w-full sm:w-auto" :disabled="!searchConfigLoaded || searchConfigSaving">
                      <span x-show="!searchConfigSaving">Save Search Config</span>
                      <span x-show="searchConfigSaving" class="flex items-center gap-2"> ${spinner('h-4 w-4')} Saving... </span>
                    </button>

                    <button @click="testSearchConfig()" class="btn-ghost w-full sm:w-auto" :disabled="!searchConfigLoaded || searchConfigTesting || searchConfigDraft.provider === 'disabled'">
                      <span x-show="!searchConfigTesting">Test Search</span>
                      <span x-show="searchConfigTesting" class="flex items-center gap-2"> ${spinner('h-4 w-4')} Testing... </span>
                    </button>

                    <p class="text-xs text-gray-500" x-show="searchConfigDraft.provider === 'disabled'">Search testing is disabled until a provider is selected.</p>
                  </div>

                  <template x-if="searchConfigTestResult">
                    <div class="bg-surface-900 rounded-xl border border-white/5 p-4">
                      <div class="flex flex-col gap-3 mb-4 sm:flex-row sm:items-center sm:justify-between">
                        <div class="min-w-0">
                          <p class="text-sm font-medium text-white">Search Test Result</p>
                          <p class="text-xs text-gray-500">Provider: <span x-text="searchConfigTestResult.provider"></span> · Query: <span x-text="searchConfigTestResult.query"></span></p>
                        </div>
                        <span
                          class="text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-full"
                          :class="searchConfigTestResult.ok ? 'bg-accent-emerald/10 text-accent-emerald' : 'bg-red-500/10 text-red-400'"
                          x-text="searchConfigTestResult.ok ? 'OK' : 'Error'"
                        ></span>
                      </div>

                      <template x-if="searchConfigTestResult.ok">
                        <div class="space-y-3">
                          <template x-for="result in searchConfigTestResult.results" :key="result.url + result.title">
                            <div class="rounded-lg border border-white/5 bg-surface-800 p-3">
                              <div class="flex items-start justify-between gap-3 mb-1">
                                <div>
                                  <a :href="result.url" target="_blank" class="text-sm font-medium text-accent-cyan hover:underline break-words" x-text="result.title"></a>
                                  <p class="text-[11px] text-gray-500 break-all" x-text="result.url"></p>
                                </div>
                                <span class="text-[10px] text-gray-600 uppercase tracking-widest" x-show="result.pageAge" x-text="result.pageAge"></span>
                              </div>
                              <p class="text-sm text-gray-300 leading-relaxed" x-text="result.previewText"></p>
                            </div>
                          </template>
                        </div>
                      </template>

                      <template x-if="!searchConfigTestResult.ok">
                        <div class="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                          <p class="text-sm text-red-300 font-medium" x-text="searchConfigTestResult.error.code"></p>
                          <p class="text-sm text-gray-300 mt-1" x-text="searchConfigTestResult.error.message"></p>
                        </div>
                      </template>
                    </div>
                  </template>
                </div>
              </template>
            </div>
          </div>

          <div class="flex flex-col gap-5">
            <div class="glass-card p-5 sm:p-6 animate-in delay-1">
              <h3 class="text-white font-semibold mb-4">API Endpoints</h3>
              <div class="min-w-0">
                ${endpointRow('POST', '/v1/messages', 'Anthropic Messages', 'https://docs.anthropic.com/en/api/messages')}
                ${endpointRow('POST', '/v1/messages/count_tokens', 'Anthropic Count Tokens', 'https://docs.anthropic.com/en/api/messages-count-tokens')}
                ${endpointRow('POST', '/v1/responses', 'OpenAI Responses', 'https://platform.openai.com/docs/api-reference/responses/create')}
                ${endpointRow('POST', '/v1/chat/completions', 'OpenAI Chat Completions', 'https://platform.openai.com/docs/api-reference/chat/create')}
                ${endpointRow('POST', '/v1/embeddings', 'OpenAI Embeddings', 'https://platform.openai.com/docs/api-reference/embeddings/create')}
                ${endpointRow('GET', '/v1/models', 'OpenAI Models', 'https://platform.openai.com/docs/api-reference/models/list')}
              </div>
            </div>

            <div class="glass-card p-5 sm:p-6 animate-in delay-2">
              <h3 class="text-white font-semibold mb-1">Export Data</h3>
              <p class="text-sm text-gray-400 mb-4">Download all API keys, GitHub accounts, and usage data as a JSON file.</p>
              <label class="mb-4 flex items-start gap-3 rounded-md border border-white/5 bg-surface-800/50 p-3">
                <input type="checkbox" class="mt-0.5 h-4 w-4 rounded border-white/10 bg-surface-900 text-accent-cyan" x-model="exportIncludePerformance" />
                <span>
                  <span class="block text-sm font-medium text-gray-200"> Include Performance Telemetry </span>
                  <span class="block text-xs text-gray-500"> Adds latency histogram history to the export. </span>
                </span>
              </label>
              <button @click="exportData()" class="btn-primary" :disabled="exportLoading">
                <span x-show="!exportLoading" class="flex items-center gap-2">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Export JSON
                </span>
                <span x-show="exportLoading" class="flex items-center gap-2"> ${spinner('h-4 w-4')} Exporting... </span>
              </button>

              <div class="my-6 border-t border-white/[0.06]"></div>

              <h3 class="text-white font-semibold mb-1">Import Data</h3>
              <p class="text-sm text-gray-400 mb-4">Restore data from a previously exported JSON file.</p>

              <div class="mb-4">
                <label
                  class="block w-full cursor-pointer border-2 border-dashed border-white/10 hover:border-accent-cyan/30 rounded-xl p-8 text-center transition-colors"
                  :class="importFile ? 'border-accent-cyan/40 bg-accent-cyan/5' : ''"
                >
                  <input type="file" accept=".json" class="hidden" @change="handleImportFile($event)" />
                  <template x-if="!importFile">
                    <div>
                      <svg class="w-8 h-8 mx-auto mb-2 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                      <p class="text-sm text-gray-400">Click to select a JSON export file</p>
                    </div>
                  </template>
                  <template x-if="importFile">
                    <div>
                      <svg class="w-8 h-8 mx-auto mb-2 text-accent-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      <p class="text-sm text-white break-all" x-text="importFile.name"></p>
                      <p class="text-xs text-gray-500 mt-1" x-text="'Exported: ' + (importPreview.exportedAt ? new Date(importPreview.exportedAt).toLocaleString() : 'unknown')"></p>
                    </div>
                  </template>
                </label>
              </div>

              <template x-if="importPreview.ready">
                <div>
                  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
                    <div class="bg-surface-800 rounded-lg p-3 text-center">
                      <p class="text-xs text-gray-500 mb-1">API Keys</p>
                      <p class="text-lg font-bold font-mono text-white" x-text="importPreview.apiKeys"></p>
                    </div>
                    <div class="bg-surface-800 rounded-lg p-3 text-center">
                      <p class="text-xs text-gray-500 mb-1">GitHub Accounts</p>
                      <p class="text-lg font-bold font-mono text-white" x-text="importPreview.githubAccounts"></p>
                    </div>
                    <div class="bg-surface-800 rounded-lg p-3 text-center">
                      <p class="text-xs text-gray-500 mb-1">Usage Records</p>
                      <p class="text-lg font-bold font-mono text-white" x-text="importPreview.usage"></p>
                    </div>
                    <div class="bg-surface-800 rounded-lg p-3 text-center">
                      <p class="text-xs text-gray-500 mb-1">Search Usage Records</p>
                      <p class="text-lg font-bold font-mono text-white" x-text="importPreview.searchUsage"></p>
                    </div>
                    <div class="bg-surface-800 rounded-lg p-3 text-center">
                      <p class="text-xs text-gray-500 mb-1">Performance Records</p>
                      <p class="text-lg font-bold font-mono text-white" x-text="importPreview.performance"></p>
                    </div>
                  </div>

                  <div class="flex flex-col gap-3 mb-4 sm:flex-row">
                    <button
                      @click="importMode = 'merge'"
                      class="flex-1 p-3 rounded-lg border text-left transition-all"
                      :class="importMode === 'merge' ? 'border-accent-cyan/50 bg-accent-cyan/5' : 'border-white/10 hover:border-white/20'"
                    >
                      <p class="text-sm font-medium" :class="importMode === 'merge' ? 'text-accent-cyan' : 'text-white'">Merge</p>
                      <p class="text-xs text-gray-500 mt-0.5">Keep existing data, add/update imported records</p>
                    </button>
                    <button
                      @click="importMode = 'replace'"
                      class="flex-1 p-3 rounded-lg border text-left transition-all"
                      :class="importMode === 'replace' ? 'border-red-400/50 bg-red-400/5' : 'border-white/10 hover:border-white/20'"
                    >
                      <p class="text-sm font-medium" :class="importMode === 'replace' ? 'text-red-400' : 'text-white'">Replace</p>
                      <p class="text-xs text-gray-500 mt-0.5">Wipe all existing data and restore from file</p>
                    </button>
                  </div>

                  <template x-if="importMode === 'replace'">
                    <div class="bg-red-500/10 border border-red-500/20 rounded-lg p-3 mb-4">
                      <p class="text-sm text-red-400">This will permanently delete all existing data before importing. This cannot be undone.</p>
                    </div>
                  </template>

                  <button @click="doImport()" class="btn-primary w-full sm:w-auto" :disabled="importLoading" :class="importMode === 'replace' ? 'bg-red-500/80 hover:bg-red-500' : ''">
                    <span x-show="!importLoading" class="flex items-center gap-2">
                      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                      <span x-text="importMode === 'replace' ? 'Replace All Data' : 'Merge Data'"></span>
                    </span>
                    <span x-show="importLoading" class="flex items-center gap-2"> ${spinner('h-4 w-4')} Importing... </span>
                  </button>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>
    </template>
  `;
}

export function renderModelsTab() {
  return html`
    <div x-show="tab === 'models'" x-transition:enter="transition ease-out duration-200" x-transition:enter-start="opacity-0" x-transition:enter-end="opacity-100">
      <div class="glass-card glow-border animate-in flex h-[calc(100dvh-130px)] min-h-[560px] flex-col overflow-hidden lg:h-[calc(100vh-140px)] lg:flex-row">
        <!-- Left: Model list -->
        <div class="max-h-56 w-full shrink-0 border-b border-white/[0.06] flex flex-col lg:max-h-none lg:w-72 lg:border-b-0 lg:border-r">
          <div class="p-3 border-b border-white/[0.06]">
            <input type="text" x-model="modelsSearch" placeholder="Filter models..." style="padding:8px 12px; font-size:12px; border-radius:8px;" />
          </div>
          <div class="flex-1 overflow-y-auto">
            <template x-for="(m, i) in filteredChatModels" :key="m.id || ('div-'+i)">
              <div>
                <div x-show="m._divider" class="border-t border-white/[0.1] mx-3 my-1"></div>
                <button
                  x-show="!m._divider"
                  @click="selectChatModel(m.id)"
                  class="w-full min-h-11 text-left px-4 py-2.5 transition-colors border-l-2"
                  :class="[chatModelId === m.id
                    ? 'bg-accent-cyanGlow text-accent-cyan border-l-accent-cyan'
                    : 'text-gray-400 hover:bg-white/[0.03] hover:text-gray-200 border-l-transparent',
                    (() => { const next = filteredChatModels[i+1]; return next && !next._divider ? 'border-b border-white/[0.03]' : ''; })()]"
                >
                  <div class="text-[13px] truncate" :class="chatModelId === m.id ? 'text-white' : 'text-gray-300'" x-text="m.name"></div>
                  <div class="text-[11px] font-mono truncate mt-0.5 opacity-60" x-text="m.id"></div>
                </button>
              </div>
            </template>
            <div x-show="filteredChatModels.length === 0" class="p-4 text-center text-gray-600 text-xs">No models found</div>
          </div>
        </div>

        <!-- Right: Info + Chat -->
        <div class="flex-1 flex flex-col min-w-0 min-h-0">
          <!-- Model info bar -->
          <div x-show="chatModelInfo" class="shrink-0 p-4 border-b border-white/[0.06]">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <h3 class="text-sm font-semibold text-white" x-text="chatModelInfo?.name"></h3>
                <p class="text-[11px] text-gray-500 mt-0.5 break-all">
                  <span class="font-mono" x-text="chatModelInfo?.id"></span>
                  <span class="mx-1 text-gray-700">/</span>
                  <span x-text="chatModelInfo?.capabilities?.family" class="text-accent-cyan"></span>
                </p>
              </div>
              <button @click="clearChat()" class="btn-ghost text-[11px] flex shrink-0 items-center gap-1" :disabled="chatMessages.length === 0">
                <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
                Clear
              </button>
            </div>
            <div class="flex flex-wrap gap-1.5 mt-2">
              <template x-if="chatModelInfo?.capabilities?.limits?.max_prompt_tokens">
                <span class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-surface-600 text-gray-400">
                  prompt: <span x-text="Math.round(chatModelInfo.capabilities.limits.max_prompt_tokens/1000)+'K'"></span>
                </span>
              </template>
              <template x-if="chatModelInfo?.capabilities?.limits?.max_output_tokens">
                <span class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-surface-600 text-gray-400">
                  output: <span x-text="Math.round(chatModelInfo.capabilities.limits.max_output_tokens/1000)+'K'"></span>
                </span>
              </template>
              <template x-for="cap in chatModelCaps" :key="cap">
                <span class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-accent-cyanGlow text-accent-cyanDim" x-text="cap"></span>
              </template>
              <template x-for="ep in (chatModelInfo?.supported_endpoints || [])" :key="ep">
                <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-surface-700 text-gray-500" x-text="ep"></span>
              </template>
            </div>
          </div>

          <div x-show="!chatModelInfo" class="flex-1 flex items-center justify-center text-gray-600 text-sm">Select a model to begin</div>

          <!-- Chat messages -->
          <div x-show="chatModelInfo" class="flex-1 overflow-y-auto p-4 space-y-3" x-ref="chatScroll">
            <div x-show="chatMessages.length === 0 && !chatSending" class="flex items-center justify-center h-full text-gray-600 text-xs">Send a message to start chatting</div>
            <template x-for="(msg, i) in chatMessages" :key="i">
              <div class="flex" :class="msg.role === 'user' ? 'justify-end' : 'justify-start'">
                <div
                  class="max-w-[86%] sm:max-w-[75%] rounded-2xl px-4 py-2.5 text-sm break-words"
                  :class="msg.role === 'user'
                      ? 'bg-accent-cyan/10 text-gray-200 rounded-br-md'
                      : 'bg-surface-600 text-gray-300 rounded-bl-md'"
                >
                  <template x-if="msg.imageUrl"><img :src="msg.imageUrl" class="max-w-full max-h-48 rounded-lg mb-2" /></template><span x-text="msg.text" style="white-space: pre-wrap;"></span>
                </div>
              </div>
            </template>
            <div x-show="chatSending && (chatMessages.length === 0 || chatMessages[chatMessages.length-1].role === 'user')" class="flex justify-start">
              <div class="bg-surface-600 rounded-2xl rounded-bl-md px-4 py-2.5">
                <span class="inline-flex gap-1">
                  <span class="w-1.5 h-1.5 bg-accent-cyan rounded-full animate-bounce" style="animation-delay:0s"></span>
                  <span class="w-1.5 h-1.5 bg-accent-cyan rounded-full animate-bounce" style="animation-delay:0.15s"></span>
                  <span class="w-1.5 h-1.5 bg-accent-cyan rounded-full animate-bounce" style="animation-delay:0.3s"></span>
                </span>
              </div>
            </div>
          </div>

          <!-- Input -->
          <div x-show="chatModelInfo" class="shrink-0 p-3 border-t border-white/[0.06]">
            <div class="flex flex-col gap-2 mb-2 sm:flex-row sm:items-center" x-show="chatShowImage">
              <input type="text" x-model="chatImageUrl" placeholder="Image URL (optional)" style="padding:6px 10px; font-size:11px; border-radius:8px;" />
              <button @click="chatShowImage = false; chatImageUrl = ''" class="text-gray-600 hover:text-gray-400 text-[11px] self-start sm:self-auto">cancel</button>
            </div>
            <div class="flex gap-2">
              <button
                @click="chatShowImage = !chatShowImage"
                class="shrink-0 min-h-11 min-w-11 p-2 rounded-lg bg-surface-600 text-gray-500 hover:text-accent-cyan transition-colors inline-flex items-center justify-center"
                aria-label="Attach image URL"
                title="Attach image URL"
              >
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="M21 15l-5-5L5 21" />
                </svg>
              </button>
              <textarea
                x-model="chatInput"
                @keydown.enter="if (!$event.shiftKey) { $event.preventDefault(); sendChatMessage(); }"
                placeholder="Type a message..."
                rows="2"
                style="font-size:13px; padding:10px 14px; min-height:42px; max-height:200px;"
                :disabled="chatSending"
              ></textarea>
              <button
                @click="sendChatMessage()"
                :disabled="chatSending || (!chatInput.trim() && !chatImageUrl.trim())"
                class="btn-primary shrink-0 flex items-center gap-1"
                style="padding:8px 16px; border-radius:10px; font-size:13px;"
              >
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                </svg>
                <span x-text="chatSending ? '\\u2026' : 'Send'"></span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}
