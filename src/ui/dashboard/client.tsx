import { html, raw } from 'hono/html';

import { activeCredentialValue, draftFromSearchConfig, searchConfigFromDraft, setActiveCredentialValue } from './search-config.ts';

export function dashboardAssets() {
  return html`
    <style>
      select option {
        background: #13181f;
        color: #e0e0e0;
      }
    </style>

    <script>
      function dashboardApp() {
        const isAdmin = localStorage.getItem('isAdmin') === '1';
        const TABS = isAdmin ? ['settings', 'models', 'keys', 'usage', 'performance'] : ['models', 'keys', 'usage', 'performance'];
        const defaultTab = isAdmin ? 'settings' : 'models';
        const initTab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : defaultTab;

        // Chart instances and key name map stored outside Alpine to avoid reactive proxy wrapping
        const _charts = { key: null, model: null, searchKey: null, performanceModel: null };
        const _keyNameMap = new Map();
        const _detailMaps = { key: null, model: null, searchKey: null };
        let _modelsLoadPromise = null;

        function destroyCharts() {
          for (const k of ['key', 'model', 'searchKey', 'performanceModel']) {
            if (_charts[k]) {
              _charts[k].stop();
              _charts[k].destroy();
              _charts[k] = null;
            }
          }
        }

        const pad2 = n => String(n).padStart(2, '0');

        function chartXAxisTickCallback(bucketKeys, labels, compact4h) {
          return (_value, index) => {
            const label = labels[index] ?? '';
            if (!compact4h) return label;
            const hour = Number(String(bucketKeys[index] ?? '').slice(11, 13));
            return Number.isFinite(hour) && hour % 8 === 0 ? label : '';
          };
        }

        function copyTextWithTextarea(text) {
          const textarea = document.createElement('textarea');
          textarea.value = text;
          textarea.setAttribute('readonly', '');
          textarea.style.position = 'fixed';
          textarea.style.top = '0';
          textarea.style.left = '-9999px';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.focus();
          textarea.select();
          try {
            if (!document.execCommand('copy')) {
              throw new Error('document.execCommand("copy") failed');
            }
          } finally {
            document.body.removeChild(textarea);
          }
        }

        async function copyText(text) {
          const value = String(text);
          const clipboard = globalThis.navigator?.clipboard;
          // Clipboard API is absent outside secure contexts in some browsers, so
          // dashboard copy buttons keep a click-bound textarea fallback.
          if (clipboard?.writeText) {
            await clipboard.writeText(value);
            return;
          }
          copyTextWithTextarea(value);
        }

        function formatTokenCount(n) {
          return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
        }

        function formatDurationMs(ms) {
          if (ms === null || ms === undefined) return '\\u2014';
          if (ms >= 60000) return (ms / 60000).toFixed(1) + 'm';
          if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
          return Math.round(ms) + 'ms';
        }

        function renderHitRate(cacheRead, cacheCreation) {
          const total = cacheRead + cacheCreation;
          return total > 0 ? ((cacheRead / total) * 100).toFixed(1) + '%' : '\\u2014';
        }

        function renderInputRate(tokens, input) {
          return input > 0 ? ((tokens / input) * 100).toFixed(1) + '%' : '\\u2014';
        }

        function prefillInputTokens(input, cacheRead) {
          return input - cacheRead;
        }

        const TOKEN_CHART_METRICS = {
          requests: { label: 'Requests', kind: 'count' },
          cost: { label: 'Est. Cost', kind: 'cost' },
          total: { label: 'Total Tokens', kind: 'tokens' },
          input: { label: 'Input Tokens', kind: 'tokens' },
          output: { label: 'Output Tokens', kind: 'tokens' },
          cached: { label: 'Cached Input', kind: 'tokens' },
          cachedRate: { label: 'Cached Rate', kind: 'percent' },
          prefill: { label: 'Prefill Input', kind: 'tokens' },
          cacheCreation: { label: 'Cache Write', kind: 'tokens' },
          cacheHitRate: { label: 'Cache Hit Rate', kind: 'percent' },
        };

        const USAGE_CHART_PALETTE = ['#00e5ff', '#00e676', '#ffd740', '#ff5252', '#7c4dff', '#ff6e40', '#64ffda', '#eeff41', '#40c4ff', '#ea80fc'];

        function usageChartColor(slot) {
          return USAGE_CHART_PALETTE[slot % USAGE_CHART_PALETTE.length];
        }

        function compareUsageKeyIds(a, b, keyMetaMap) {
          const am = keyMetaMap.get(a) || {};
          const bm = keyMetaMap.get(b) || {};
          if (am.createdAt && bm.createdAt && am.createdAt !== bm.createdAt) return am.createdAt.localeCompare(bm.createdAt);
          if (am.createdAt !== bm.createdAt) return am.createdAt ? -1 : 1;
          return a.localeCompare(b);
        }

        function usageKeyColorSlots(colorOrder) {
          const explicitSlotById = new Map();
          const futureSlotByIndex = new Map();
          let maxFutureIndex = 0;
          for (let i = 0; i < colorOrder.length; i++) {
            const token = colorOrder[i];
            const futureMatch = token.match(/^future-(\\d+)$/);
            if (futureMatch) {
              const futureIndex = Number(futureMatch[1]);
              futureSlotByIndex.set(futureIndex, i);
              maxFutureIndex = Math.max(maxFutureIndex, futureIndex);
            } else {
              explicitSlotById.set(token, i);
            }
          }
          return { explicitSlotById, futureSlotByIndex, maxFutureIndex };
        }

        function usageFutureColorSlot(futureIndex, colorOrderLength, futureSlotByIndex, maxFutureIndex) {
          return futureSlotByIndex.get(futureIndex) ?? colorOrderLength + futureIndex - maxFutureIndex - 1;
        }

        function usageKeyChartEntries(keyIds, keyMetaMap, keyIdsForOrder = keyIds, colorOrder = []) {
          const present = new Set(keyIds);
          const { explicitSlotById, futureSlotByIndex, maxFutureIndex } = usageKeyColorSlots(colorOrder);
          const futureKeyIds = [...new Set([...keyIdsForOrder, ...keyIds])].filter(keyId => !explicitSlotById.has(keyId)).sort((a, b) => compareUsageKeyIds(a, b, keyMetaMap));
          const futureSlotByKeyId = new Map(futureKeyIds.map((keyId, i) => [keyId, usageFutureColorSlot(i + 1, colorOrder.length, futureSlotByIndex, maxFutureIndex)]));

          return [...present]
            .map(keyId => ({
              keyId,
              colorSlot: explicitSlotById.get(keyId) ?? futureSlotByKeyId.get(keyId),
            }))
            .filter(entry => entry.colorSlot !== undefined)
            .sort((a, b) => a.colorSlot - b.colorSlot || compareUsageKeyIds(a.keyId, b.keyId, keyMetaMap));
        }

        function tokenModelChartEntries(models, knownModels) {
          const present = new Set(models);
          const order = [...new Set([...knownModels, ...models])].sort();
          return order.map((model, slot) => ({ model, colorSlot: slot })).filter(entry => present.has(entry.model));
        }

        function tokenChartMetricRecordValue(record, metric) {
          if (metric === 'requests') return record.requests;
          if (metric === 'cost') return record.cost ?? 0;
          if (metric === 'input') return record.inputTokens;
          if (metric === 'output') return record.outputTokens;
          if (metric === 'cached') return record.cacheReadTokens ?? 0;
          if (metric === 'prefill') return prefillInputTokens(record.inputTokens, record.cacheReadTokens ?? 0);
          if (metric === 'cacheCreation') return record.cacheCreationTokens ?? 0;
          return record.inputTokens + record.outputTokens;
        }

        function tokenChartMetricDetailValue(detail, metric) {
          if (metric === 'cacheHitRate') {
            const total = detail.cacheRead + detail.cacheCreation;
            return total > 0 ? (detail.cacheRead / total) * 100 : null;
          }
          if (metric === 'cachedRate') {
            return detail.input > 0 ? (detail.cacheRead / detail.input) * 100 : null;
          }
          return null;
        }

        function isTokenChartPercentMetric(metric) {
          return TOKEN_CHART_METRICS[metric]?.kind === 'percent';
        }

        function tokenChartMetricLabel(metric) {
          return TOKEN_CHART_METRICS[metric]?.label || TOKEN_CHART_METRICS.total.label;
        }

        function formatTokenChartAxisValue(value, metric) {
          if (TOKEN_CHART_METRICS[metric]?.kind === 'percent') return value.toFixed(0) + '%';
          if (TOKEN_CHART_METRICS[metric]?.kind === 'count') return Math.round(value).toLocaleString();
          if (TOKEN_CHART_METRICS[metric]?.kind === 'cost') return formatCost(value);
          return formatTokenCount(value);
        }

        function tooltipLabelWidth(chart) {
          return chart.data.datasets.reduce((maxLen, ds) => Math.max(maxLen, String(ds.label || '').length), 0);
        }

        function formatTooltipHeader(labelWidth) {
          return (
            '  ' +
            ''.padEnd(labelWidth + 1) +
            'Req'.padStart(5) +
            '  ' +
            'Cost'.padStart(9) +
            '  ' +
            'Total'.padStart(7) +
            '  ' +
            'Cached'.padStart(7) +
            '  ' +
            'Cached%'.padStart(8) +
            '  ' +
            'Prefill'.padStart(7) +
            '  ' +
            'Output'.padStart(7) +
            '  ' +
            'Hit%'.padStart(7)
          );
        }

        function formatTooltipRow(label, labelWidth, detail) {
          const cached = detail.cacheRead;
          const prefill = prefillInputTokens(detail.input, cached);
          return (
            label.padEnd(labelWidth + 1) +
            String(detail.requests).padStart(5) +
            '  ' +
            formatCost(detail.cost).padStart(9) +
            '  ' +
            formatTokenCount(detail.input + detail.output).padStart(7) +
            '  ' +
            formatTokenCount(cached).padStart(7) +
            '  ' +
            renderInputRate(cached, detail.input).padStart(8) +
            '  ' +
            formatTokenCount(prefill).padStart(7) +
            '  ' +
            formatTokenCount(detail.output).padStart(7) +
            '  ' +
            renderHitRate(detail.cacheRead, detail.cacheCreation).padStart(7)
          );
        }

        function formatCost(cost) {
          if (cost >= 1) return '$' + cost.toFixed(2);
          if (cost >= 0.01) return '$' + cost.toFixed(3);
          if (cost > 0) return '$' + cost.toFixed(4);
          return '$0';
        }

        const CLAUDE_TIER = { opus: 0, sonnet: 1, haiku: 2 };
        const LLM_ENDPOINTS = ['/v1/messages', '/responses', '/chat/completions'];

        function modelContextWindow(model) {
          const limits = model.capabilities?.limits;
          return limits?.max_context_window_tokens || (limits?.max_prompt_tokens || 0) + (limits?.max_output_tokens || 0);
        }

        function modelSupportsGeneration(model) {
          if (model.supports_generation !== undefined) return model.supports_generation;
          if (Array.isArray(model.supported_endpoints)) {
            return model.supported_endpoints.some(endpoint => LLM_ENDPOINTS.includes(endpoint));
          }
          return model.capabilities?.type !== 'embeddings';
        }

        function claudeTier(id) {
          for (const t in CLAUDE_TIER) {
            if (id.includes(t)) return CLAUDE_TIER[t];
          }
          return 99;
        }

        function sortClaudeBig(a, b) {
          const ta = claudeTier(a);
          const tb = claudeTier(b);
          return ta !== tb ? ta - tb : b.localeCompare(a);
        }

        function sortClaudeSmall(a, b) {
          const ta = claudeTier(a);
          const tb = claudeTier(b);
          return ta !== tb ? tb - ta : b.localeCompare(a);
        }

        function sortClaudeSonnet(a, b) {
          const da = Math.abs(claudeTier(a) - CLAUDE_TIER.sonnet);
          const db = Math.abs(claudeTier(b) - CLAUDE_TIER.sonnet);
          return da !== db ? da - db : b.localeCompare(a);
        }

        function sortCodex(a, b) {
          const am = a.includes('mini') ? 1 : 0;
          const bm = b.includes('mini') ? 1 : 0;
          return am !== bm ? am - bm : b.localeCompare(a);
        }

        // Hono escapes interpolated strings in this template, but these helpers are
        // embedded as executable script source, so they must be injected raw.
        const draftFromSearchConfig = ${raw(draftFromSearchConfig.toString())};
        const activeCredentialValue = ${raw(activeCredentialValue.toString())};
        const setActiveCredentialValue = ${raw(setActiveCredentialValue.toString())};
        const searchConfigFromDraft = ${raw(searchConfigFromDraft.toString())};

        return {
          authKey: '',
          isAdmin,
          tab: initTab,
          meLoaded: false,
          githubAccounts: [],
          selectedGithubAccountId: null,
          usageData: null,
          usageError: false,
          usagePercent: 0,
          deviceFlow: { loading: false, userCode: null, verificationUri: null, deviceCode: null, pollTimer: null },
          keys: [],
          keysLoading: false,
          now: Date.now(),
          newKeyName: '',
          selectedKeyId: null,
          keyCreating: false,
          keyDeleting: null,
          keyRotating: null,
          copied: false,
          modelsLoaded: false,
          claudeModelsBig: [],
          claudeModelsSonnet: [],
          claudeModelsSmall: [],
          claudeContextMap: {},
          claudeModel: '',
          claudeSonnetModel: '',
          claudeSmallModel: '',
          codexModels: [],
          codexModel: '',
          modelPickerSeparator: '',
          tokenRange: 'today',
          tokenChartMetric: 'total',
          tokenData: [],
          tokenKeyMetadata: [],
          tokenKeyColorOrder: [],
          searchUsageData: [],
          searchUsageActiveProvider: 'disabled',
          searchUsageLoading: false,
          searchUsageKeyMetadata: [],
          searchUsageKeyColorOrder: [],
          performanceRange: 'today',
          performanceMetricScope: 'request_total',
          performanceChartView: 'model',
          performancePercentile: 'p95Ms',
          performanceModel: '',
          performanceSeries: [],
          performanceSummaryRows: [],
          performanceModelRows: [],
          performanceRuntimeRows: [],
          performanceLoading: false,
          performanceSummary: { requests: 0, errors: 0, avgMs: null, p50Ms: null, p95Ms: null, p99Ms: null },
          chartsReady: false,
          tokenLoading: false,
          tokenSummary: { requests: 0, total: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, prefill: 0 },
          hiddenKeys: new Set(),
          hiddenModels: new Set(),
          redactKeys: false,
          exportLoading: false,
          exportIncludePerformance: false,
          importFile: null,
          importData: null,
          importMode: 'merge',
          importLoading: false,
          importPreview: { ready: false, exportedAt: null, apiKeys: 0, githubAccounts: 0, usage: 0, searchUsage: 0, performance: 0 },
          // Models tab — chat playground
          allModels: [],
          modelsSearch: '',
          chatModelId: '',
          chatMessages: [], // {role, text, imageUrl?}
          chatInput: '',
          chatImageUrl: '',
          chatShowImage: false,
          chatSending: false,
          chatStreamText: '',
          searchConfigDraft: draftFromSearchConfig({
            provider: 'disabled',
            tavily: { apiKey: '' },
            microsoftGrounding: { apiKey: '' },
          }),
          searchConfigLoaded: false,
          searchConfigSaving: false,
          searchConfigTesting: false,
          searchConfigTestResult: null,
          upstreams: [],
          upstreamsLoaded: false,
          upstreamTestingId: null,
          upstreamFixCatalog: [],
          upstreamFixCatalogLoaded: false,
          upstreamTestResult: null,
          upstreamModal: {
            open: false,
            id: null,
            name: '',
            baseUrl: '',
            bearerToken: '',
            supportedEndpoints: ['/chat/completions'],
            enabled: true,
            sortOrder: 100,
            enabledFixes: [],
            pathOverrides: {
              chat_completions: '',
              responses: '',
              messages: '',
              embeddings: '',
              models: '',
            },
            // Path overrides default to collapsed; auto-open in edit
            // mode if the upstream already has any override set so the
            // admin sees the live values without an extra click.
            pathOverridesOpen: false,
            saving: false,
            error: null,
          },
          _chatAbort: null,

          get baseUrl() {
            return location.origin;
          },

          get githubConnected() {
            return this.githubAccounts.length > 0;
          },

          get chatModelInfo() {
            return this.allModels.find(m => m.id === this.chatModelId) || null;
          },

          get chatModelCaps() {
            const s = this.chatModelInfo?.capabilities?.supports;
            if (!s) return [];
            const caps = [];
            if (s.vision) caps.push('vision');
            if (s.tool_calls) caps.push('tools');
            if (s.streaming) caps.push('streaming');
            if (s.adaptive_thinking) caps.push('thinking');
            return caps;
          },

          get generationModels() {
            return this.allModels.filter(modelSupportsGeneration);
          },

          get filteredChatModels() {
            let models = this.generationModels;
            if (this.modelsSearch.trim()) {
              const q = this.modelsSearch.toLowerCase();
              models = models.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || (m.display_name || '').toLowerCase().includes(q));
            }
            const enabled = models.filter(m => m.model_picker_enabled);
            const legacy = models.filter(m => !m.model_picker_enabled);
            if (enabled.length && legacy.length) return [...enabled, { _divider: true }, ...legacy];
            return [...enabled, ...legacy];
          },

          get activeKey() {
            const sel = this.selectedKeyId && this.keys.find(k => k.id === this.selectedKeyId);
            if (sel) return sel.key;
            return this.isAdmin ? '<your-api-key>' : this.authKey;
          },

          get searchCredentialValue() {
            return activeCredentialValue(this.searchConfigDraft);
          },

          get searchCredentialLabel() {
            return this.searchConfigDraft.provider === 'tavily' ? 'Tavily API Key' : this.searchConfigDraft.provider === 'microsoft-grounding' ? 'Microsoft Grounding API Key' : 'Credential';
          },

          setSearchCredentialValue(value) {
            this.searchConfigDraft = setActiveCredentialValue(this.searchConfigDraft, value);
            this.searchConfigTestResult = null;
          },

          setSearchConfigProvider(provider) {
            this.searchConfigDraft = { ...this.searchConfigDraft, provider };
            this.searchConfigTestResult = null;
          },

          truncateKey(key) {
            if (!key || key.length <= 12) return key;
            return key.slice(0, 4) + '\\u2026' + key.slice(-4);
          },

          formatHitRate(cacheRead, cacheCreation) {
            return renderHitRate(cacheRead, cacheCreation);
          },

          formatInputRate(tokens, input) {
            return renderInputRate(tokens, input);
          },

          formatDuration(ms) {
            return formatDurationMs(ms);
          },

          performancePercentileLabel(metric = this.performancePercentile) {
            if (metric === 'p50Ms') return 'p50';
            if (metric === 'p99Ms') return 'p99';
            return 'p95';
          },

          performanceModelOptions() {
            return [...new Set(this.performanceSeries.map(row => row.group))].sort();
          },

          timeAgo(dateStr) {
            if (!dateStr) return null;
            const date = new Date(dateStr);
            const diff = this.now - date;
            const seconds = Math.floor(diff / 1000);
            if (seconds < 60) return 'just now';
            const minutes = Math.floor(seconds / 60);
            if (minutes < 60) return minutes + (minutes === 1 ? ' minute ago' : ' minutes ago');
            const hours = Math.floor(minutes / 60);
            if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
            const days = Math.floor(hours / 24);
            if (days <= 30) return days + (days === 1 ? ' day ago' : ' days ago');
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          },

          fullDateTime(dateStr) {
            if (!dateStr) return '';
            const d = new Date(dateStr);
            return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
          },

          claudeCodeSnippet() {
            const addCtx = id => {
              const p = this.claudeContextMap[id];
              return p >= 1000000 ? id + '[1m]' : id;
            };
            const lines = [
              'export ANTHROPIC_BASE_URL=' + this.baseUrl,
              'export ANTHROPIC_AUTH_TOKEN=' + this.activeKey,
              'export ANTHROPIC_MODEL=' + addCtx(this.claudeModel),
              'export ANTHROPIC_DEFAULT_SONNET_MODEL=' + addCtx(this.claudeSonnetModel),
              'export ANTHROPIC_DEFAULT_HAIKU_MODEL=' + this.claudeSmallModel,
            ];
            return lines.join('\\n');
          },

          codexSnippet() {
            const lines = [
              'model = "' + this.codexModel + '"',
              'model_provider = "copilot_gateway"',
              '',
              '[model_providers.copilot_gateway]',
              'name = "Copilot Gateway"',
              'base_url = "' + this.baseUrl + '/"',
              'env_key = "COPILOT_GATEWAY_API_KEY"',
              'wire_api = "responses"',
            ];
            return lines.join('\\n');
          },

          codexEnvSnippet() {
            return 'export COPILOT_GATEWAY_API_KEY=' + this.activeKey;
          },

          init() {
            this.authKey = localStorage.getItem('authKey') || '';
            if (!this.authKey) {
              window.location.href = '/';
              return;
            }

            const modelsReady = this.ensureModelsLoaded();

            if (this.tab === 'settings' && this.isAdmin) {
              this.loadMe().then(() => this.loadUsage());
              this.loadSearchConfig();
              this.loadUpstreams();
            } else if (this.tab === 'keys') {
              this.loadKeys();
            } else if (this.tab === 'usage') {
              this.loadUsageTabData(modelsReady);
            } else if (this.tab === 'performance') {
              this.loadPerformanceTabData();
            }

            setInterval(() => {
              if (this.tab === 'settings' && this.isAdmin) this.loadUsage();
              if (this.tab === 'usage') this.loadUsageTabData();
              if (this.tab === 'performance') this.loadPerformanceTabData();
            }, 60000);

            setInterval(() => {
              this.now = Date.now();
            }, 30000);

            window.addEventListener('hashchange', () => {
              const h = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : defaultTab;
              if (this.tab !== h) this.switchTab(h);
            });
          },

          authHeaders() {
            return { 'x-api-key': this.authKey };
          },

          async switchTab(t) {
            if (t !== this.tab) {
              destroyCharts();
              this.chartsReady = false;
            }
            this.tab = t;
            location.hash = '#' + t;
            if (t === 'settings' && this.isAdmin) {
              if (!this.meLoaded) await this.loadMe();
              await this.loadUsage();
              if (!this.searchConfigLoaded) this.loadSearchConfig();
              if (!this.upstreamsLoaded) this.loadUpstreams();
            } else if (t === 'usage') {
              this.tokenLoading = true;
              this.searchUsageLoading = true;
              await this.loadUsageTabData();
            } else if (t === 'performance') {
              this.performanceLoading = true;
              await this.loadPerformanceTabData();
            } else if (t === 'keys') {
              await this.loadKeys();
            } else if (t === 'models') {
              if (this.allModels.length === 0) await this.loadAllModels();
            }
          },

          ensureModelsLoaded() {
            if (this.modelsLoaded || this.allModels.length > 0) return Promise.resolve();
            if (!_modelsLoadPromise) {
              _modelsLoadPromise = this.loadModels().finally(() => {
                _modelsLoadPromise = null;
              });
            }
            return _modelsLoadPromise;
          },

          // Force a full reload after admin upstream CRUD/test so the
          // models picker reflects the current upstream set without
          // waiting for an in-process cache refresh.
          reloadModels() {
            this.modelsLoaded = false;
            this.allModels = [];
            return this.ensureModelsLoaded();
          },

          async loadModels() {
            try {
              const resp = await fetch('/api/models', { headers: this.authHeaders() });
              if (!resp.ok) {
                console.error('loadModels: HTTP', resp.status);
                return;
              }
              const { data: rawData } = await resp.json();
              const data = rawData.map(m => ({
                ...m,
                name: m.display_name || m.name || m.id,
                supports_generation: modelSupportsGeneration(m),
              }));

              this.allModels = data;
              if (!this.chatModelId) {
                const first = this.filteredChatModels.find(m => !m._divider);
                if (first) this.chatModelId = first.id;
              }

              // Split models into copilot and custom-upstream groups so the
              // dashboard can present them separately. Copilot lists are
              // sorted by Claude tier (so claude-* SKUs sit near the top of
              // their respective pickers) while custom-upstream lists are
              // surfaced as-is — admins configure those by hand and there
              // is no canonical "tier" to apply.
              const messagesCapable = data.filter(m => {
                const eps = m.supported_endpoints ?? [];
                return eps.includes('/v1/messages') || eps.includes('/responses') || eps.includes('/chat/completions');
              });

              // Context window map — backend model listing has already
              // collapsed dated/variant aliases into base ids, so we can
              // key directly by model id.
              this.claudeContextMap = Object.fromEntries(data.filter(m => m.id.startsWith('claude-') && m.supported_endpoints?.includes('/v1/messages')).map(m => [m.id, modelContextWindow(m)]));

              const SEPARATOR = '── Custom Upstreams ──';
              const isCopilot = m => m.upstream_kind !== 'openai';
              const dedupe = ids => [...new Set(ids)];
              // Restrict the Copilot Claude segment to claude-* SKUs that
              // natively speak /v1/messages. Other Copilot SKUs (gpt-*,
              // gemini-*, ...) are not useful as a Claude Code backend, and
              // claude SKUs that are translation-only on Copilot are too
              // narrow to be the right default for the Claude pickers.
              // Custom upstreams are admin-curated and surfaced in full.
              //
              // Backend model merging has already collapsed dated and
              // variant aliases (-xhigh, -1m) into base ids, so we key
              // directly by model id without configModelName dedupe.
              const copilotIds = dedupe(
                messagesCapable
                  .filter(isCopilot)
                  .filter(m => m.id.startsWith('claude-'))
                  .filter(m => m.supported_endpoints?.includes('/v1/messages'))
                  .map(m => m.id),
              );
              const customClaudeIds = messagesCapable
                .filter(m => !isCopilot(m))
                .map(m => m.id)
                .sort((a, b) => a.localeCompare(b));

              const buildClaudePicker = sortFn => {
                const copilotSorted = [...copilotIds].sort(sortFn);
                // Only insert the separator when both segments are
                // non-empty. With no Copilot models the picker would
                // otherwise lead with a disabled separator row.
                return copilotSorted.length > 0 && customClaudeIds.length > 0 ? [...copilotSorted, SEPARATOR, ...customClaudeIds] : [...copilotSorted, ...customClaudeIds];
              };

              this.claudeModelsBig = buildClaudePicker(sortClaudeBig);
              this.claudeModelsSonnet = buildClaudePicker(sortClaudeSonnet);
              this.claudeModelsSmall = buildClaudePicker(sortClaudeSmall);
              const pickFirst = list => list.find(id => id !== SEPARATOR) || '';
              this.claudeModel = pickFirst(this.claudeModelsBig);
              this.claudeSonnetModel = pickFirst(this.claudeModelsSonnet);
              this.claudeSmallModel = pickFirst(this.claudeModelsSmall);

              // Codex CLI talks the Responses protocol; any
              // upstream that supports /responses natively or that
              // can be served by responses-via-chat-completions
              // translation qualifies. Backend model listing has already
              // collapsed variants, so we key by id directly.
              const codexCapable = data.filter(m => {
                const eps = m.supported_endpoints ?? [];
                return eps.includes('/responses') || eps.includes('/chat/completions');
              });
              const copilotCodex = dedupe(
                codexCapable
                  .filter(isCopilot)
                  .filter(m => m.supported_endpoints?.includes('/responses'))
                  .map(m => m.id),
              ).sort(sortCodex);
              const customCodex = codexCapable
                .filter(m => !isCopilot(m))
                .map(m => m.id)
                .sort((a, b) => a.localeCompare(b));
              this.codexModels = copilotCodex.length > 0 && customCodex.length > 0 ? [...copilotCodex, SEPARATOR, ...customCodex] : [...copilotCodex, ...customCodex];
              this.codexModel = pickFirst(this.codexModels);
              this.modelPickerSeparator = SEPARATOR;

              this.modelsLoaded = true;
              if (this.tab === 'usage' && this.chartsReady) {
                await this.$nextTick();
                this.renderTokenCharts();
              }
            } catch (e) {
              console.error('loadModels:', e);
            }
          },

          async loadMe() {
            try {
              const resp = await fetch('/auth/me', { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              const data = await resp.json();
              this.githubAccounts = data.accounts || [];
              if (!this.githubAccounts.some(acct => acct.id === this.selectedGithubAccountId)) {
                this.selectedGithubAccountId = this.githubAccounts[0]?.id ?? null;
              }
            } catch (e) {
              console.error('loadMe:', e);
            } finally {
              this.meLoaded = true;
            }
          },

          async loadUsage() {
            // Quota is Copilot-only — skip the call when no GitHub
            // account is selected so the dashboard doesn't log
            // a 502 on every poll for users on custom upstreams.
            if (!this.selectedGithubAccountId) {
              this.usageData = null;
              this.usageError = false;
              this.usagePercent = 0;
              return;
            }
            try {
              const resp = await fetch('/api/copilot-quota?user_id=' + encodeURIComponent(this.selectedGithubAccountId), { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (resp.ok) {
                this.usageData = await resp.json();
                const pi = this.usageData.quota_snapshots.premium_interactions;
                this.usagePercent = pi.entitlement > 0 ? Math.round(((pi.entitlement - pi.remaining) / pi.entitlement) * 100) : 0;
                this.usageError = false;
              } else {
                this.usageError = true;
              }
            } catch {
              this.usageError = true;
            }
          },

          async loadSearchConfig() {
            try {
              const resp = await fetch('/api/search-config', { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (!resp.ok) {
                console.error('loadSearchConfig: HTTP', resp.status);
                return;
              }
              this.searchConfigDraft = draftFromSearchConfig(await resp.json());
              this.searchConfigLoaded = true;
              this.searchConfigTestResult = null;
            } catch (e) {
              console.error('loadSearchConfig:', e);
            }
          },

          async saveSearchConfig() {
            this.searchConfigSaving = true;
            try {
              const resp = await fetch('/api/search-config', {
                method: 'PUT',
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify(searchConfigFromDraft(this.searchConfigDraft)),
              });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (!resp.ok) {
                console.error('saveSearchConfig: HTTP', resp.status);
                return;
              }
              this.searchConfigDraft = draftFromSearchConfig(await resp.json());
              this.searchConfigLoaded = true;
            } catch (e) {
              console.error('saveSearchConfig:', e);
            } finally {
              this.searchConfigSaving = false;
            }
          },

          async testSearchConfig() {
            this.searchConfigTesting = true;
            this.searchConfigTestResult = null;
            try {
              const resp = await fetch('/api/search-config/test', {
                method: 'POST',
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify(searchConfigFromDraft(this.searchConfigDraft)),
              });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              this.searchConfigTestResult = await resp.json();
            } catch (e) {
              console.error('testSearchConfig:', e);
            } finally {
              this.searchConfigTesting = false;
            }
          },

          async loadUpstreams() {
            try {
              const resp = await fetch('/api/upstreams', { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (!resp.ok) {
                console.error('loadUpstreams: HTTP', resp.status);
                return;
              }
              this.upstreams = await resp.json();
              this.upstreamsLoaded = true;
            } catch (e) {
              console.error('loadUpstreams:', e);
            }
            if (!this.upstreamFixCatalogLoaded) {
              try {
                const resp = await fetch('/api/upstream-fixes', { headers: this.authHeaders() });
                if (resp.status === 401) {
                  this.logout();
                  return;
                }
                if (resp.ok) {
                  this.upstreamFixCatalog = await resp.json();
                  this.upstreamFixCatalogLoaded = true;
                } else {
                  console.error('loadUpstreams (fixes): HTTP', resp.status);
                }
              } catch (e) {
                console.error('loadUpstreams (fixes):', e);
              }
            }
          },

          openUpstreamModal(existing) {
            const blankOverrides = () => ({
              chat_completions: '',
              responses: '',
              messages: '',
              embeddings: '',
              models: '',
            });
            if (existing) {
              const overrides = { ...blankOverrides(), ...(existing.path_overrides ?? {}) };
              const hasOverrides = Object.values(existing.path_overrides ?? {}).some(v => typeof v === 'string' && v.length > 0);
              const existingFixes = Array.isArray(existing.enabled_fixes) ? [...existing.enabled_fixes] : [];
              this.upstreamModal = {
                open: true,
                id: existing.id,
                name: existing.name,
                baseUrl: existing.base_url,
                bearerToken: '',
                supportedEndpoints: [...existing.supported_endpoints],
                enabled: existing.enabled,
                sortOrder: existing.sort_order,
                enabledFixes: existingFixes,
                enabledFixesOpen: existingFixes.length > 0,
                pathOverrides: overrides,
                pathOverridesOpen: hasOverrides,
                saving: false,
                error: null,
              };
            } else {
              const nextSort = this.upstreams.reduce((m, u) => Math.max(m, u.sort_order), -1) + 1;
              this.upstreamModal = {
                open: true,
                id: null,
                name: '',
                baseUrl: '',
                bearerToken: '',
                supportedEndpoints: ['/chat/completions'],
                enabled: true,
                sortOrder: nextSort,
                enabledFixes: [],
                enabledFixesOpen: false,
                pathOverrides: blankOverrides(),
                pathOverridesOpen: false,
                saving: false,
                error: null,
              };
            }
          },

          upstreamModalOverrideCount() {
            return Object.values(this.upstreamModal.pathOverrides ?? {}).filter(v => typeof v === 'string' && v.trim()).length;
          },

          closeUpstreamModal() {
            this.upstreamModal.open = false;
          },

          toggleUpstreamEndpoint(ep) {
            const list = this.upstreamModal.supportedEndpoints;
            const idx = list.indexOf(ep);
            if (idx === -1) list.push(ep);
            else list.splice(idx, 1);
          },

          toggleUpstreamFix(id) {
            const list = this.upstreamModal.enabledFixes;
            const idx = list.indexOf(id);
            if (idx === -1) list.push(id);
            else list.splice(idx, 1);
          },

          async saveUpstream() {
            this.upstreamModal.saving = true;
            this.upstreamModal.error = null;
            try {
              const isEdit = !!this.upstreamModal.id;
              // Send only non-empty path overrides — blank input means
              // "use the default", so the field should be absent rather
              // than fail server-side validation as an empty string.
              const overrides = {};
              for (const [k, v] of Object.entries(this.upstreamModal.pathOverrides ?? {})) {
                if (typeof v === 'string' && v.trim()) overrides[k] = v.trim();
              }
              const body = {
                name: this.upstreamModal.name,
                base_url: this.upstreamModal.baseUrl,
                supported_endpoints: this.upstreamModal.supportedEndpoints,
                enabled: this.upstreamModal.enabled,
                sort_order: this.upstreamModal.sortOrder,
                enabled_fixes: this.upstreamModal.enabledFixes,
                path_overrides: Object.keys(overrides).length > 0 ? overrides : null,
              };
              if (this.upstreamModal.bearerToken) {
                body.bearer_token = this.upstreamModal.bearerToken;
              }
              const url = isEdit ? '/api/upstreams/' + this.upstreamModal.id : '/api/upstreams';
              const resp = await fetch(url, {
                method: isEdit ? 'PATCH' : 'POST',
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                this.upstreamModal.error = err.error || 'HTTP ' + resp.status;
                return;
              }
              this.closeUpstreamModal();
              await this.loadUpstreams();
              this.reloadModels();
            } catch (e) {
              this.upstreamModal.error = e.message || String(e);
            } finally {
              this.upstreamModal.saving = false;
            }
          },

          async deleteUpstream(id, name) {
            if (!confirm('Delete upstream "' + name + '"?')) return;
            try {
              const resp = await fetch('/api/upstreams/' + id, {
                method: 'DELETE',
                headers: this.authHeaders(),
              });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (!resp.ok) {
                alert('Delete failed: HTTP ' + resp.status);
                return;
              }
              await this.loadUpstreams();
              this.reloadModels();
            } catch (e) {
              console.error('deleteUpstream:', e);
            }
          },

          async testUpstream(id) {
            this.upstreamTestingId = id;
            this.upstreamTestResult = null;
            try {
              const resp = await fetch('/api/upstreams/' + id + '/test', {
                method: 'POST',
                headers: this.authHeaders(),
              });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              this.upstreamTestResult = await resp.json();
              if (this.upstreamTestResult?.ok) this.reloadModels();
            } catch (e) {
              this.upstreamTestResult = { ok: false, error: e.message || String(e) };
            } finally {
              this.upstreamTestingId = null;
            }
          },

          formatDate(s) {
            return s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
          },

          async startGithubAuth() {
            this.deviceFlow.loading = true;
            try {
              const resp = await fetch('/auth/github', { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              const d = await resp.json();
              if (d.user_code) {
                Object.assign(this.deviceFlow, {
                  userCode: d.user_code,
                  verificationUri: d.verification_uri,
                  deviceCode: d.device_code,
                });
                this.pollDeviceFlow(d.interval || 5);
              }
            } catch (e) {
              console.error('startGithubAuth:', e);
            } finally {
              this.deviceFlow.loading = false;
            }
          },

          pollDeviceFlow(interval) {
            this.deviceFlow.pollTimer = setInterval(async () => {
              try {
                const resp = await fetch('/auth/github/poll', {
                  method: 'POST',
                  headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                  body: JSON.stringify({ device_code: this.deviceFlow.deviceCode }),
                });
                if (resp.status === 401) {
                  this.logout();
                  return;
                }
                const d = await resp.json();
                if (d.status === 'complete') {
                  this.cancelDeviceFlow();
                  await this.loadMe();
                  await this.loadUsage();
                } else if (d.status === 'slow_down') {
                  clearInterval(this.deviceFlow.pollTimer);
                  this.pollDeviceFlow((d.interval || interval) + 1);
                } else if (d.status === 'error') {
                  this.cancelDeviceFlow();
                  alert('Authorization failed: ' + d.error);
                }
              } catch (e) {
                console.error('poll:', e);
              }
            }, interval * 1000);
          },

          cancelDeviceFlow() {
            clearInterval(this.deviceFlow.pollTimer);
            Object.assign(this.deviceFlow, {
              pollTimer: null,
              userCode: null,
              verificationUri: null,
              deviceCode: null,
            });
          },

          async disconnectGithub(userId, login) {
            if (!confirm('Disconnect @' + login + '? The stored token will be deleted.')) return;
            try {
              const resp = await fetch('/auth/github/' + userId, { method: 'DELETE', headers: this.authHeaders() });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (resp.ok) {
                await this.loadMe();
                if (!this.githubConnected) {
                  this.usageData = null;
                  this.usageError = false;
                  this.usagePercent = 0;
                } else {
                  await this.loadUsage();
                }
              } else {
                alert('Failed to disconnect GitHub account');
              }
            } catch (e) {
              console.error('disconnectGithub:', e);
            }
          },

          async selectGithubAccount(userId) {
            if (this.selectedGithubAccountId === userId) return;
            this.selectedGithubAccountId = userId;
            await this.loadUsage();
          },

          async moveGithubAccount(userId, direction) {
            const index = this.githubAccounts.findIndex(acct => acct.id === userId);
            const nextIndex = index + direction;
            if (index < 0 || nextIndex < 0 || nextIndex >= this.githubAccounts.length) return;

            const ordered = [...this.githubAccounts];
            const current = ordered[index];
            ordered[index] = ordered[nextIndex];
            ordered[nextIndex] = current;

            try {
              const resp = await fetch('/auth/github/order', {
                method: 'POST',
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_ids: ordered.map(acct => acct.id) }),
              });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (resp.ok) {
                this.githubAccounts = ordered;
                await this.loadMe();
                await this.loadUsage();
              } else {
                alert('Failed to update account order');
              }
            } catch (e) {
              console.error('moveGithubAccount:', e);
            }
          },

          async loadKeys() {
            this.keysLoading = true;
            try {
              const resp = await fetch('/api/keys', { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (resp.ok) {
                this.keys = await resp.json();
                if (this.selectedKeyId && !this.keys.some(k => k.id === this.selectedKeyId)) {
                  this.selectedKeyId = null;
                }
              }
            } catch (e) {
              console.error('loadKeys:', e);
            } finally {
              this.keysLoading = false;
            }
          },

          async createNewKey() {
            const name = this.newKeyName.trim();
            if (!name) return;
            this.keyCreating = true;
            try {
              const resp = await fetch('/api/keys', {
                method: 'POST',
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
              });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (resp.ok) {
                const created = await resp.json();
                this.selectedKeyId = created.id;
                this.newKeyName = '';
                await this.loadKeys();
              } else {
                alert((await resp.json()).error || 'Failed to create key');
              }
            } catch (e) {
              console.error('createKey:', e);
            } finally {
              this.keyCreating = false;
            }
          },

          async deleteKeyById(id, name) {
            if (!confirm('Delete key "' + name + '"? This cannot be undone.')) return;
            this.keyDeleting = id;
            try {
              const resp = await fetch('/api/keys/' + id, { method: 'DELETE', headers: this.authHeaders() });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (resp.ok) {
                await this.loadKeys();
              } else {
                alert((await resp.json()).error || 'Failed to delete key');
              }
            } catch (e) {
              console.error('deleteKey:', e);
            } finally {
              this.keyDeleting = null;
            }
          },

          async rotateKeyById(id, name) {
            if (!confirm('Rotate key "' + name + '"? The old key will stop working immediately.')) return;
            this.keyRotating = id;
            try {
              const resp = await fetch('/api/keys/' + id + '/rotate', { method: 'POST', headers: this.authHeaders() });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (resp.ok) {
                this.selectedKeyId = id;
                await this.loadKeys();
              } else {
                alert((await resp.json()).error || 'Failed to rotate key');
              }
            } catch (e) {
              console.error('rotateKey:', e);
            } finally {
              this.keyRotating = null;
            }
          },

          async renameKeyById(id, currentName) {
            const newName = prompt('Rename key:', currentName);
            if (!newName || newName === currentName) return;
            try {
              const resp = await fetch('/api/keys/' + id, {
                method: 'PATCH',
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName }),
              });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (resp.ok) {
                await this.loadKeys();
              } else {
                alert((await resp.json()).error || 'Failed to rename key');
              }
            } catch (e) {
              console.error('renameKey:', e);
            }
          },

          async copySnippet(text, tag) {
            await copyText(text);
            this.copied = tag;
            setTimeout(() => {
              this.copied = false;
            }, 2000);
          },

          localHourKey(d) {
            return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours());
          },

          localDateKey(d) {
            return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
          },

          local8hBucketStart(d) {
            const aligned = new Date(d);
            aligned.setMinutes(0, 0, 0);
            aligned.setHours(aligned.getHours() - (aligned.getHours() % 8));
            return aligned;
          },

          local8hBucketKey(d) {
            return this.localHourKey(this.local8hBucketStart(d));
          },

          local4hBucketStart(d) {
            const aligned = new Date(d);
            aligned.setMinutes(0, 0, 0);
            aligned.setHours(aligned.getHours() - (aligned.getHours() % 4));
            return aligned;
          },

          local4hBucketKey(d) {
            return this.localHourKey(this.local4hBucketStart(d));
          },

          build8hBucketMap(count) {
            const map = new Map();
            const start = this.local8hBucketStart(new Date());
            let prevDateKey = null;
            for (let i = count - 1; i >= 0; i--) {
              const d = new Date(start.getTime() - i * 8 * 3600000);
              const key = this.localHourKey(d);
              const dateKey = this.localDateKey(d);
              const startH = d.getHours();
              const endH = (startH + 8) % 24;
              const time = pad2(startH) + ':00 \\u2013 ' + pad2(endH) + ':00';
              const datePrefix = dateKey !== prevDateKey ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' : '';
              map.set(key, datePrefix + time);
              prevDateKey = dateKey;
            }
            return map;
          },

          build4hBucketMap(count) {
            const map = new Map();
            const start = this.local4hBucketStart(new Date());
            let prevDateKey = null;
            for (let i = count - 1; i >= 0; i--) {
              const d = new Date(start.getTime() - i * 4 * 3600000);
              const key = this.localHourKey(d);
              const h = d.getHours();
              const dateKey = this.localDateKey(d);
              const endH = (h + 4) % 24;
              const time = pad2(h) + ':00 \\u2013 ' + pad2(endH) + ':00';
              const datePrefix = dateKey !== prevDateKey ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' : '';
              map.set(key, datePrefix + time);
              prevDateKey = dateKey;
            }
            return map;
          },

          usageRangeParams() {
            const now = new Date();
            const rangeStart = new Date(now);
            if (this.tokenRange === 'today') {
              rangeStart.setTime(now.getTime() - 23 * 3600000);
              rangeStart.setMinutes(0, 0, 0);
            } else if (this.tokenRange === '7d') {
              rangeStart.setTime(this.local4hBucketStart(now).getTime() - 41 * 4 * 3600000);
            } else {
              rangeStart.setDate(rangeStart.getDate() - 29);
              rangeStart.setHours(0, 0, 0, 0);
            }
            return {
              start: rangeStart.toISOString().slice(0, 13),
              end: new Date(now.getTime() + 3600000).toISOString().slice(0, 13),
            };
          },

          async fetchTokenData(range = this.usageRangeParams()) {
            try {
              const resp = await fetch('/api/token-usage?start=' + encodeURIComponent(range.start) + '&end=' + encodeURIComponent(range.end) + '&include_key_metadata=1', {
                headers: this.authHeaders(),
              });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (resp.ok) {
                const body = await resp.json();
                if (Array.isArray(body)) {
                  this.tokenData = body;
                  this.tokenKeyMetadata = [];
                  this.tokenKeyColorOrder = [];
                } else {
                  this.tokenData = Array.isArray(body.records) ? body.records : [];
                  this.tokenKeyMetadata = Array.isArray(body.keys) ? body.keys : [];
                  this.tokenKeyColorOrder = Array.isArray(body.keyColorOrder) ? body.keyColorOrder : [];
                }
              }
            } catch (e) {
              console.error('fetchTokenData:', e);
            }
          },

          async fetchSearchUsageData(range = this.usageRangeParams()) {
            try {
              const resp = await fetch('/api/search-usage?start=' + encodeURIComponent(range.start) + '&end=' + encodeURIComponent(range.end) + '&include_key_metadata=1', {
                headers: this.authHeaders(),
              });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (resp.ok) {
                const body = await resp.json();
                this.searchUsageData = Array.isArray(body.records) ? body.records : [];
                this.searchUsageKeyMetadata = Array.isArray(body.keys) ? body.keys : [];
                this.searchUsageKeyColorOrder = Array.isArray(body.keyColorOrder) ? body.keyColorOrder : [];
                this.searchUsageActiveProvider = body.activeProvider || 'disabled';
              }
            } catch (e) {
              console.error('fetchSearchUsageData:', e);
            }
          },

          async fetchUsageTabData() {
            const range = this.usageRangeParams();
            await Promise.all([this.fetchTokenData(range), this.fetchSearchUsageData(range)]);
          },

          async loadUsageTabData(modelsReady = this.ensureModelsLoaded()) {
            const expectedRange = this.tokenRange;
            this.tokenLoading = true;
            this.searchUsageLoading = true;
            try {
              await Promise.all([modelsReady, this.fetchUsageTabData()]);
              if (this.tab !== 'usage' || this.tokenRange !== expectedRange) return;
              await this.$nextTick();
              this.renderTokenCharts();
            } finally {
              this.tokenLoading = false;
              this.searchUsageLoading = false;
            }
          },

          performanceRangeParams() {
            const now = new Date();
            const rangeStart = new Date(now);
            if (this.performanceRange === 'today') {
              rangeStart.setTime(now.getTime() - 23 * 3600000);
              rangeStart.setMinutes(0, 0, 0);
            } else if (this.performanceRange === '7d') {
              rangeStart.setTime(this.local4hBucketStart(now).getTime() - 41 * 4 * 3600000);
            } else {
              rangeStart.setDate(rangeStart.getDate() - 29);
              rangeStart.setHours(0, 0, 0, 0);
            }
            return {
              start: rangeStart.toISOString().slice(0, 13),
              end: new Date(now.getTime() + 3600000).toISOString().slice(0, 13),
            };
          },

          performanceBucketGranularity() {
            if (this.performanceRange === 'today') return 'hour';
            if (this.performanceRange === '7d') return '4h';
            return 'day';
          },

          buildPerformanceBucketMap() {
            const bucketMap = new Map();
            const now = new Date();
            if (this.performanceRange === 'today') {
              const cur = new Date(now);
              cur.setMinutes(0, 0, 0);
              for (let i = 23; i >= 0; i--) {
                const d = new Date(cur.getTime() - i * 3600000);
                const h = d.getHours();
                bucketMap.set(this.localHourKey(d), pad2(h) + ':00 \\u2013 ' + pad2((h + 1) % 24) + ':00');
              }
            } else if (this.performanceRange === '7d') {
              return this.build4hBucketMap(42);
            } else {
              const days = 30;
              for (let i = days - 1; i >= 0; i--) {
                const d = new Date(now);
                d.setDate(d.getDate() - i);
                d.setHours(0, 0, 0, 0);
                bucketMap.set(this.localDateKey(d), d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
              }
            }
            return bucketMap;
          },

          async fetchPerformanceOverview() {
            const range = this.performanceRangeParams();
            const params = new URLSearchParams({
              start: range.start,
              end: range.end,
              bucket: this.performanceBucketGranularity(),
              metric_scope: this.performanceMetricScope,
              timezone_offset_minutes: String(new Date().getTimezoneOffset()),
            });
            const resp = await fetch('/api/performance/overview?' + params.toString(), { headers: this.authHeaders() });
            if (resp.status === 401) {
              this.logout();
              return null;
            }
            if (!resp.ok) return null;
            const body = await resp.json();
            return body && typeof body === 'object' ? body : null;
          },

          async loadPerformanceTabData() {
            const expectedRange = this.performanceRange;
            const expectedScope = this.performanceMetricScope;
            this.performanceLoading = true;
            try {
              const overview = await this.fetchPerformanceOverview();
              if (this.tab !== 'performance' || this.performanceRange !== expectedRange || this.performanceMetricScope !== expectedScope) return;
              this.performanceSeries = Array.isArray(overview?.series) ? overview.series : [];
              this.performanceSummaryRows = Array.isArray(overview?.summaryRows) ? overview.summaryRows : [];
              this.performanceModelRows = Array.isArray(overview?.modelRows) ? overview.modelRows : [];
              const runtimeRows = Array.isArray(overview?.runtimeRows) ? overview.runtimeRows : [];
              this.performanceRuntimeRows = runtimeRows.filter(row => row.group !== 'unknown' || runtimeRows.length > 1);
              this.ensurePerformanceModelSelected();
              this.updatePerformanceSummary();
              await this.$nextTick();
              this.renderPerformanceChart();
            } catch (e) {
              console.error('loadPerformanceTabData:', e);
            } finally {
              this.performanceLoading = false;
            }
          },

          updatePerformanceSummary() {
            const row = this.performanceSummaryRows[0];
            this.performanceSummary = row
              ? { requests: row.requests, errors: row.errors, avgMs: row.avgMs, p50Ms: row.p50Ms, p95Ms: row.p95Ms, p99Ms: row.p99Ms }
              : { requests: 0, errors: 0, avgMs: null, p50Ms: null, p95Ms: null, p99Ms: null };
          },

          renderPerformanceChart() {
            const canvas = document.getElementById('performanceChartByModel');
            if (!canvas || canvas.clientWidth === 0) return;
            if (_charts.performanceModel) {
              _charts.performanceModel.stop();
              _charts.performanceModel.destroy();
              _charts.performanceModel = null;
            }

            const sourceRows = this.performanceChartView === 'percentile' ? this.performanceSeries.filter(row => row.group === this.performanceModel) : this.performanceSeries;
            const bucketMap = this.buildPerformanceBucketMap();
            const bucketKeysArr = [...bucketMap.keys()];
            const labels = [...bucketMap.values()];
            const percentileMetrics = ['p50Ms', 'p95Ms', 'p99Ms'];
            const datasets =
              this.performanceChartView === 'percentile'
                ? percentileMetrics.map((metric, index) => {
                    const color = usageChartColor(index);
                    const valueByBucket = new Map(sourceRows.map(row => [row.bucket, row[metric]]));
                    return {
                      label: this.performancePercentileLabel(metric),
                      data: bucketKeysArr.map(bucket => valueByBucket.get(bucket) ?? null),
                      borderColor: color,
                      backgroundColor: color + '25',
                      borderWidth: 2,
                      pointRadius: 2,
                      pointHoverRadius: 5,
                      tension: 0.25,
                      fill: false,
                      spanGaps: true,
                    };
                  })
                : [...new Set(this.performanceSeries.map(row => row.group))].sort().map((group, index) => {
                    const color = usageChartColor(index);
                    const valueByKey = new Map(this.performanceSeries.map(row => [row.bucket + '\\0' + row.group, row[this.performancePercentile]]));
                    return {
                      label: group,
                      data: bucketKeysArr.map(bucket => valueByKey.get(bucket + '\\0' + group) ?? null),
                      borderColor: color,
                      backgroundColor: color + '25',
                      borderWidth: 2,
                      pointRadius: 2,
                      pointHoverRadius: 5,
                      tension: 0.25,
                      fill: false,
                      spanGaps: true,
                    };
                  });

            const self = this;
            _charts.performanceModel = new Chart(canvas, {
              type: 'line',
              data: { labels, datasets },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                  legend: {
                    position: 'bottom',
                    labels: { color: '#9e9e9e', font: { size: 11, family: "'DM Sans', sans-serif" }, boxWidth: 12, padding: 16, usePointStyle: true, pointStyle: 'circle' },
                  },
                  tooltip: {
                    backgroundColor: 'rgba(12,16,21,0.95)',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    titleColor: '#e0e0e0',
                    bodyColor: '#b0bec5',
                    padding: 12,
                    filter: item => item.parsed.y !== null,
                    callbacks: { label: ctx => ctx.dataset.label + ': ' + formatDurationMs(ctx.parsed.y) },
                  },
                },
                scales: {
                  x: {
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: {
                      color: '#9e9e9e',
                      font: { size: 10, family: "'DM Sans', sans-serif" },
                      maxRotation: 45,
                      callback: chartXAxisTickCallback(bucketKeysArr, labels, self.performanceRange === '7d'),
                    },
                    border: { color: 'rgba(255,255,255,0.06)' },
                  },
                  y: {
                    type: 'logarithmic',
                    beginAtZero: false,
                    title: {
                      display: true,
                      text: self.performanceChartView === 'percentile' ? self.performanceModel + ' latency' : self.performancePercentileLabel() + ' latency',
                      color: '#9e9e9e',
                      font: { size: 10, family: "'DM Sans', sans-serif" },
                    },
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: { color: '#9e9e9e', font: { size: 10, family: "'JetBrains Mono', monospace" }, callback: v => formatDurationMs(Number(v)) },
                    border: { color: 'rgba(255,255,255,0.06)' },
                  },
                },
              },
            });
            this.chartsReady = true;
          },

          ensurePerformanceModelSelected() {
            const models = this.performanceModelOptions();
            if (models.length === 0) {
              this.performanceModel = '';
              return;
            }
            if (!models.includes(this.performanceModel)) {
              this.performanceModel = models[0];
            }
          },

          async loadTokenUsage() {
            await this.loadUsageTabData();
          },

          buildBucketMap() {
            const bucketMap = new Map();
            const now = new Date();
            if (this.tokenRange === 'today') {
              const cur = new Date(now);
              cur.setMinutes(0, 0, 0);
              for (let i = 23; i >= 0; i--) {
                const d = new Date(cur.getTime() - i * 3600000);
                const h = d.getHours();
                bucketMap.set(this.localHourKey(d), pad2(h) + ':00 \\u2013 ' + pad2((h + 1) % 24) + ':00');
              }
            } else if (this.tokenRange === '7d') {
              return this.build4hBucketMap(42);
            } else {
              const days = 30;
              for (let i = days - 1; i >= 0; i--) {
                const d = new Date(now);
                d.setDate(d.getDate() - i);
                d.setHours(0, 0, 0, 0);
                bucketMap.set(this.localDateKey(d), d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
              }
            }
            return bucketMap;
          },

          tokenBucketKeyFor(d) {
            if (this.tokenRange === 'today') return this.localHourKey(d);
            if (this.tokenRange === '7d') return this.local4hBucketKey(d);
            return this.localDateKey(d);
          },

          aggregateBuckets(records, dimension, metric = this.tokenChartMetric) {
            const bucketMap = this.buildBucketMap();
            const agg = new Map();
            const detail = new Map();
            for (const [key] of bucketMap) {
              agg.set(key, new Map());
              detail.set(key, new Map());
            }
            for (const r of records) {
              const utc = new Date(r.hour + ':00:00Z');
              const bucket = this.tokenBucketKeyFor(utc);
              if (!agg.has(bucket)) continue;
              const m = agg.get(bucket);
              const val = dimension === 'model' ? r.model : r[dimension];
              if (!isTokenChartPercentMetric(metric)) {
                m.set(val, (m.get(val) || 0) + tokenChartMetricRecordValue(r, metric));
              }
              const dm = detail.get(bucket);
              const prev = dm.get(val) || { requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 };
              prev.requests += r.requests;
              prev.input += r.inputTokens;
              prev.output += r.outputTokens;
              prev.cacheRead += r.cacheReadTokens ?? 0;
              prev.cacheCreation += r.cacheCreationTokens ?? 0;
              prev.cost += r.cost ?? 0;
              dm.set(val, prev);
            }
            if (isTokenChartPercentMetric(metric)) {
              for (const [bucket, values] of detail) {
                const m = agg.get(bucket);
                for (const [val, item] of values) {
                  m.set(val, tokenChartMetricDetailValue(item, metric));
                }
              }
            }
            return { bucketMap, agg, detail };
          },

          aggregateSearchUsageBuckets(records) {
            const bucketMap = this.buildBucketMap();
            const agg = new Map();
            const detail = new Map();
            for (const [key] of bucketMap) {
              agg.set(key, new Map());
              detail.set(key, new Map());
            }
            for (const r of records) {
              const utc = new Date(r.hour + ':00:00Z');
              const bucket = this.tokenBucketKeyFor(utc);
              if (!agg.has(bucket)) continue;
              const m = agg.get(bucket);
              m.set(r.keyId, (m.get(r.keyId) || 0) + r.requests);
              const dm = detail.get(bucket);
              dm.set(r.keyId, (dm.get(r.keyId) || 0) + r.requests);
            }
            return { bucketMap, agg, detail };
          },

          hasTokenChartMetricData(detail, dimensionValue) {
            if (!isTokenChartPercentMetric(this.tokenChartMetric)) return null;
            for (const values of detail.values()) {
              const item = values.get(dimensionValue);
              if (item && tokenChartMetricDetailValue(item, this.tokenChartMetric) !== null) return true;
            }
            return false;
          },

          tokenChartBucketValue(agg, bucket, dimensionValue) {
            const value = agg.get(bucket)?.get(dimensionValue);
            if (value !== undefined) return value;
            return isTokenChartPercentMetric(this.tokenChartMetric) ? null : 0;
          },

          applyTokenChartMetricOptions(chart) {
            const metric = this.tokenChartMetric;
            const isPercentMetric = isTokenChartPercentMetric(metric);
            chart.options.scales.y.stacked = !isPercentMetric;
            chart.options.scales.y.title.text = tokenChartMetricLabel(metric);
            chart.options.scales.y.suggestedMax = isPercentMetric ? 100 : undefined;
            chart.options.scales.y.ticks.callback = v => formatTokenChartAxisValue(Number(v), metric);
            for (const ds of chart.data.datasets) {
              ds.fill = isPercentMetric ? false : 'stack';
              ds.spanGaps = isPercentMetric;
            }
          },

          updateSummary() {
            const filtered = this.tokenData.filter(r => !this.hiddenKeys.has(r.keyId) && !this.hiddenModels.has(r.model));
            let totalReqs = 0,
              totalIn = 0,
              totalOut = 0,
              totalCR = 0,
              totalCC = 0,
              totalCost = 0;
            for (const r of filtered) {
              totalReqs += r.requests;
              totalIn += r.inputTokens;
              totalOut += r.outputTokens;
              totalCR += r.cacheReadTokens ?? 0;
              totalCC += r.cacheCreationTokens ?? 0;
              totalCost += r.cost ?? 0;
            }
            this.tokenSummary = {
              requests: totalReqs,
              cost: totalCost,
              total: totalIn + totalOut,
              input: totalIn,
              output: totalOut,
              cacheRead: totalCR,
              cacheCreation: totalCC,
              prefill: prefillInputTokens(totalIn, totalCR),
            };
          },

          refreshChartsData() {
            const bucketMap = this.buildBucketMap();
            const bucketKeysArr = [...bucketMap.keys()];

            if (_charts.key) {
              const filtered = this.tokenData.filter(r => !this.hiddenModels.has(r.model));
              const { agg, detail } = this.aggregateBuckets(filtered, 'keyId');
              _detailMaps.key = detail;
              this.applyTokenChartMetricOptions(_charts.key);
              for (let i = 0; i < _charts.key.data.datasets.length; i++) {
                const ds = _charts.key.data.datasets[i];
                ds.data = bucketKeysArr.map(k => this.tokenChartBucketValue(agg, k, ds._keyId));
                const userHidden = this.hiddenKeys.has(ds._keyId);
                const hasData = this.hasTokenChartMetricData(detail, ds._keyId) ?? ds.data.some(v => v !== 0);
                _charts.key.setDatasetVisibility(i, !userHidden && hasData);
              }
              _charts.key.update('none');
            }

            if (_charts.model) {
              const filtered = this.tokenData.filter(r => !this.hiddenKeys.has(r.keyId));
              const { agg, detail } = this.aggregateBuckets(filtered, 'model');
              _detailMaps.model = detail;
              this.applyTokenChartMetricOptions(_charts.model);
              for (let i = 0; i < _charts.model.data.datasets.length; i++) {
                const ds = _charts.model.data.datasets[i];
                ds.data = bucketKeysArr.map(k => this.tokenChartBucketValue(agg, k, ds._model));
                const userHidden = this.hiddenModels.has(ds._model);
                const hasData = this.hasTokenChartMetricData(detail, ds._model) ?? ds.data.some(v => v !== 0);
                _charts.model.setDatasetVisibility(i, !userHidden && hasData);
              }
              _charts.model.update('none');
            }

            if (_charts.searchKey) {
              const filtered = this.searchUsageData.filter(r => r.provider === this.searchUsageActiveProvider);
              const { agg, detail } = this.aggregateSearchUsageBuckets(filtered);
              _detailMaps.searchKey = detail;
              for (let i = 0; i < _charts.searchKey.data.datasets.length; i++) {
                const ds = _charts.searchKey.data.datasets[i];
                ds.data = bucketKeysArr.map(k => agg.get(k)?.get(ds._keyId) ?? 0);
                const userHidden = this.hiddenKeys.has(ds._keyId);
                const hasData = ds.data.some(v => v !== 0);
                _charts.searchKey.setDatasetVisibility(i, !userHidden && hasData);
              }
              _charts.searchKey.update('none');
            }

            this.updateSummary();
          },

          renderTokenCharts() {
            const canvasKey = document.getElementById('tokenChartByKey');
            const canvasModel = document.getElementById('tokenChartByModel');
            const canvasSearchKey = document.getElementById('searchUsageChartByKey');
            if (!canvasKey || !canvasModel || canvasKey.clientWidth === 0) return;

            const data = this.tokenData;
            const self = this;

            const keyNameMap = _keyNameMap;
            keyNameMap.clear();
            const keyMetaMap = new Map();
            const allKeyIds = new Set();
            const allKeyIdsForOrder = new Set();
            const allSearchKeyIds = new Set();
            const allSearchKeyIdsForOrder = new Set();
            const allModels = new Set();
            for (const k of this.tokenKeyMetadata) {
              keyNameMap.set(k.id, k.name);
              keyMetaMap.set(k.id, { name: k.name, createdAt: k.createdAt });
              allKeyIdsForOrder.add(k.id);
            }
            for (const k of this.searchUsageKeyMetadata) {
              keyNameMap.set(k.id, k.name);
              keyMetaMap.set(k.id, { name: k.name, createdAt: k.createdAt });
              allSearchKeyIdsForOrder.add(k.id);
            }
            for (const r of data) {
              keyNameMap.set(r.keyId, r.keyName);
              keyMetaMap.set(r.keyId, { name: r.keyName, createdAt: r.keyCreatedAt ?? keyMetaMap.get(r.keyId)?.createdAt });
              allKeyIds.add(r.keyId);
              allKeyIdsForOrder.add(r.keyId);
              allModels.add(r.model);
            }
            const activeSearchUsageData = this.searchUsageData.filter(r => r.provider === this.searchUsageActiveProvider);
            for (const r of activeSearchUsageData) {
              keyNameMap.set(r.keyId, r.keyName);
              keyMetaMap.set(r.keyId, { name: r.keyName, createdAt: r.keyCreatedAt ?? keyMetaMap.get(r.keyId)?.createdAt });
              allSearchKeyIds.add(r.keyId);
              allSearchKeyIdsForOrder.add(r.keyId);
            }

            const bucketMap = this.buildBucketMap();
            const labels = [...bucketMap.values()];
            const bucketKeysArr = [...bucketMap.keys()];

            const { agg: keyAgg, detail: keyDetail } = this.aggregateBuckets(data, 'keyId');
            const { agg: modelAgg, detail: modelDetail } = this.aggregateBuckets(data, 'model');
            const { agg: searchKeyAgg, detail: searchKeyDetail } = this.aggregateSearchUsageBuckets(activeSearchUsageData);
            _detailMaps.key = keyDetail;
            _detailMaps.model = modelDetail;
            _detailMaps.searchKey = searchKeyDetail;

            const keyList = usageKeyChartEntries([...allKeyIds], keyMetaMap, [...allKeyIdsForOrder], this.tokenKeyColorOrder);
            const modelList = tokenModelChartEntries(
              [...allModels],
              this.allModels.map(m => m.id),
            );
            const searchKeyList = usageKeyChartEntries([...allSearchKeyIds], keyMetaMap, [...allSearchKeyIdsForOrder], this.searchUsageKeyColorOrder);

            const keyDatasets = keyList.map(({ keyId, colorSlot }) => {
              const c = usageChartColor(colorSlot);
              return {
                label: self.redactKeys ? keyId.slice(0, 8) : keyNameMap.get(keyId) || keyId.slice(0, 8),
                data: bucketKeysArr.map(k => self.tokenChartBucketValue(keyAgg, k, keyId)),
                borderColor: c,
                backgroundColor: c + '40',
                borderWidth: 2,
                pointRadius: 2,
                pointHoverRadius: 5,
                tension: 0.3,
                fill: 'stack',
                spanGaps: isTokenChartPercentMetric(self.tokenChartMetric),
                _keyId: keyId,
              };
            });

            const modelDatasets = modelList.map(({ model, colorSlot }) => {
              const c = usageChartColor(colorSlot);
              return {
                label: model,
                data: bucketKeysArr.map(k => self.tokenChartBucketValue(modelAgg, k, model)),
                borderColor: c,
                backgroundColor: c + '40',
                borderWidth: 2,
                pointRadius: 2,
                pointHoverRadius: 5,
                tension: 0.3,
                fill: 'stack',
                spanGaps: isTokenChartPercentMetric(self.tokenChartMetric),
                _model: model,
              };
            });

            const searchKeyDatasets = searchKeyList.map(({ keyId, colorSlot }) => {
              const c = usageChartColor(colorSlot);
              return {
                label: self.redactKeys ? keyId.slice(0, 8) : keyNameMap.get(keyId) || keyId.slice(0, 8),
                data: bucketKeysArr.map(k => searchKeyAgg.get(k)?.get(keyId) ?? 0),
                borderColor: c,
                backgroundColor: c + '40',
                borderWidth: 2,
                pointRadius: 2,
                pointHoverRadius: 5,
                tension: 0.3,
                fill: 'stack',
                spanGaps: false,
                _keyId: keyId,
              };
            });

            this.updateSummary();

            const makeOptions = (onClick, chartType) => {
              const isSearchChart = chartType === 'searchKey';
              return {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                  legend: {
                    position: 'bottom',
                    labels: {
                      color: '#9e9e9e',
                      font: { size: 11, family: "'DM Sans', sans-serif" },
                      boxWidth: 12,
                      padding: 16,
                      usePointStyle: true,
                      pointStyle: 'circle',
                    },
                    onClick,
                  },
                  tooltip: {
                    backgroundColor: 'rgba(12,16,21,0.95)',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    titleColor: '#e0e0e0',
                    bodyColor: '#b0bec5',
                    padding: 12,
                    beforeBodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
                    bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
                    filter: item => item.parsed.y !== null && (isSearchChart ? item.parsed.y > 0 : isTokenChartPercentMetric(self.tokenChartMetric) || item.parsed.y > 0),
                    itemSort: (a, b) => b.parsed.y - a.parsed.y,
                    callbacks: {
                      beforeBody: items => {
                        if (isSearchChart) return [];
                        if (!items.length) return [];
                        return formatTooltipHeader(tooltipLabelWidth(items[0].chart));
                      },
                      label: ctx => {
                        const bucket = bucketKeysArr[ctx.dataIndex];
                        const dimKey = chartType === 'model' ? ctx.dataset._model : ctx.dataset._keyId;
                        const detailMap = _detailMaps[chartType];
                        const detail = detailMap?.get(bucket)?.get(dimKey);
                        if (isSearchChart) return ctx.dataset.label + ': ' + Math.round(detail ?? ctx.parsed.y).toLocaleString();
                        if (!detail) return ctx.dataset.label + ': ' + formatTokenChartAxisValue(ctx.parsed.y, self.tokenChartMetric);
                        return formatTooltipRow(String(ctx.dataset.label || ''), tooltipLabelWidth(ctx.chart), detail);
                      },
                    },
                  },
                },
                scales: {
                  x: {
                    stacked: true,
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: {
                      color: '#9e9e9e',
                      font: { size: 10, family: "'DM Sans', sans-serif" },
                      maxRotation: 45,
                      callback: chartXAxisTickCallback(bucketKeysArr, labels, self.tokenRange === '7d'),
                    },
                    border: { color: 'rgba(255,255,255,0.06)' },
                  },
                  y: {
                    stacked: isSearchChart || !isTokenChartPercentMetric(self.tokenChartMetric),
                    beginAtZero: true,
                    suggestedMax: !isSearchChart && isTokenChartPercentMetric(self.tokenChartMetric) ? 100 : undefined,
                    title: {
                      display: true,
                      text: isSearchChart ? 'Search Requests' : tokenChartMetricLabel(self.tokenChartMetric),
                      color: '#9e9e9e',
                      font: { size: 10, family: "'DM Sans', sans-serif" },
                    },
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: {
                      color: '#9e9e9e',
                      font: { size: 10, family: "'JetBrains Mono', monospace" },
                      callback: v => (isSearchChart ? Math.round(Number(v)).toLocaleString() : formatTokenChartAxisValue(Number(v), self.tokenChartMetric)),
                    },
                    border: { color: 'rgba(255,255,255,0.06)' },
                  },
                },
              };
            };

            destroyCharts();

            _charts.key = new Chart(canvasKey, {
              type: 'line',
              data: { labels, datasets: keyDatasets },
              options: makeOptions((_e, legendItem, legend) => {
                const ds = legend.chart.data.datasets[legendItem.datasetIndex];
                if (self.hiddenKeys.has(ds._keyId)) self.hiddenKeys.delete(ds._keyId);
                else self.hiddenKeys.add(ds._keyId);
                self.refreshChartsData();
              }, 'key'),
            });

            _charts.model = new Chart(canvasModel, {
              type: 'line',
              data: { labels, datasets: modelDatasets },
              options: makeOptions((_e, legendItem, legend) => {
                const ds = legend.chart.data.datasets[legendItem.datasetIndex];
                if (self.hiddenModels.has(ds._model)) self.hiddenModels.delete(ds._model);
                else self.hiddenModels.add(ds._model);
                self.refreshChartsData();
              }, 'model'),
            });

            if (canvasSearchKey && this.searchUsageActiveProvider !== 'disabled') {
              _charts.searchKey = new Chart(canvasSearchKey, {
                type: 'line',
                data: { labels, datasets: searchKeyDatasets },
                options: makeOptions((_e, legendItem, legend) => {
                  const ds = legend.chart.data.datasets[legendItem.datasetIndex];
                  if (self.hiddenKeys.has(ds._keyId)) self.hiddenKeys.delete(ds._keyId);
                  else self.hiddenKeys.add(ds._keyId);
                  self.refreshChartsData();
                }, 'searchKey'),
              });
            }

            this.chartsReady = true;
            this.refreshChartsData();
          },

          toggleRedactKeys() {
            this.redactKeys = !this.redactKeys;
            if (_charts.key) {
              for (const ds of _charts.key.data.datasets) {
                ds.label = this.redactKeys ? ds._keyId.slice(0, 8) : _keyNameMap.get(ds._keyId) || ds._keyId.slice(0, 8);
              }
              _charts.key.update('none');
            }
            if (_charts.searchKey) {
              for (const ds of _charts.searchKey.data.datasets) {
                ds.label = this.redactKeys ? ds._keyId.slice(0, 8) : _keyNameMap.get(ds._keyId) || ds._keyId.slice(0, 8);
              }
              _charts.searchKey.update('none');
            }
          },

          switchTokenRange(range) {
            this.tokenRange = range;
            destroyCharts();
            this.chartsReady = false;
            this.loadUsageTabData();
          },

          switchTokenChartMetric(metric) {
            if (!TOKEN_CHART_METRICS[metric] || this.tokenChartMetric === metric) return;
            this.tokenChartMetric = metric;
            this.refreshChartsData();
          },

          switchPerformanceRange(range) {
            if (this.performanceRange === range) return;
            this.performanceRange = range;
            destroyCharts();
            this.chartsReady = false;
            this.loadPerformanceTabData();
          },

          switchPerformanceMetricScope(scope) {
            if (this.performanceMetricScope === scope) return;
            this.performanceMetricScope = scope;
            destroyCharts();
            this.chartsReady = false;
            this.loadPerformanceTabData();
          },

          switchPerformanceChartView(view) {
            if (this.performanceChartView === view) return;
            this.performanceChartView = view;
            if (view === 'percentile') this.ensurePerformanceModelSelected();
            this.renderPerformanceChart();
          },

          switchPerformancePercentile(percentile) {
            if (this.performancePercentile === percentile) return;
            this.performancePercentile = percentile;
            this.renderPerformanceChart();
          },

          async exportData() {
            this.exportLoading = true;
            try {
              const resp = await fetch('/api/export' + (this.exportIncludePerformance ? '?include_performance=1' : ''), { headers: this.authHeaders() });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              if (!resp.ok) {
                alert('Export failed: ' + (await resp.json()).error);
                return;
              }
              const data = await resp.json();
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'copilot-export-' + new Date().toISOString().slice(0, 10) + '.json';
              a.click();
              URL.revokeObjectURL(url);
            } catch (e) {
              console.error('exportData:', e);
              alert('Export failed');
            } finally {
              this.exportLoading = false;
            }
          },

          handleImportFile(event) {
            const file = event.target.files[0];
            if (!file) return;
            this.importFile = file;
            this.importPreview = { ready: false, exportedAt: null, apiKeys: 0, githubAccounts: 0, usage: 0, searchUsage: 0, performance: 0 };
            this.importData = null;

            const reader = new FileReader();
            reader.onload = e => {
              try {
                const json = JSON.parse(e.target.result);
                if (!json.data) {
                  alert('Invalid export file: missing data field');
                  this.importFile = null;
                  return;
                }
                this.importData = json.data;
                this.importPreview = {
                  ready: true,
                  exportedAt: json.exportedAt || null,
                  apiKeys: Array.isArray(json.data.apiKeys) ? json.data.apiKeys.length : 0,
                  githubAccounts: Array.isArray(json.data.githubAccounts) ? json.data.githubAccounts.length : 0,
                  usage: Array.isArray(json.data.usage) ? json.data.usage.length : 0,
                  searchUsage: Array.isArray(json.data.searchUsage) ? json.data.searchUsage.length : 0,
                  performance: Array.isArray(json.data.performance) ? json.data.performance.length : 0,
                };
              } catch {
                alert('Invalid JSON file');
                this.importFile = null;
              }
            };
            reader.readAsText(file);
          },

          async doImport() {
            if (!this.importData) return;
            if (this.importMode === 'replace') {
              if (!confirm('This will DELETE ALL existing data and replace it with the imported file. Are you sure?')) return;
            }
            this.importLoading = true;
            try {
              const resp = await fetch('/api/import', {
                method: 'POST',
                headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: this.importMode, data: this.importData }),
              });
              if (resp.status === 401) {
                this.logout();
                return;
              }
              const result = await resp.json();
              if (resp.ok) {
                alert(
                  'Import complete: ' +
                    result.imported.apiKeys +
                    ' keys, ' +
                    result.imported.githubAccounts +
                    ' accounts, ' +
                    result.imported.usage +
                    ' usage records, ' +
                    result.imported.searchUsage +
                    ' search usage records, ' +
                    result.imported.performance +
                    ' performance records',
                );
                this.importFile = null;
                this.importData = null;
                this.importPreview = { ready: false, exportedAt: null, apiKeys: 0, githubAccounts: 0, usage: 0, searchUsage: 0, performance: 0 };
              } else {
                alert('Import failed: ' + (result.error || 'Unknown error'));
              }
            } catch (e) {
              console.error('doImport:', e);
              alert('Import failed');
            } finally {
              this.importLoading = false;
            }
          },

          // ---- Models tab ----

          async loadAllModels() {
            await this.ensureModelsLoaded();
          },

          selectChatModel(id) {
            this.chatModelId = id;
            if (this._chatAbort) {
              this._chatAbort.abort();
              this._chatAbort = null;
              this.chatSending = false;
            }
          },

          clearChat() {
            if (this._chatAbort) {
              this._chatAbort.abort();
              this._chatAbort = null;
            }
            this.chatMessages = [];
            this.chatSending = false;
            this.chatStreamText = '';
          },

          buildChatApiMessages() {
            return this.chatMessages.map(m => {
              if (m.role === 'assistant') return { role: 'assistant', content: m.text };
              if (m.imageUrl) {
                return {
                  role: 'user',
                  content: [
                    { type: 'image_url', image_url: { url: m.imageUrl } },
                    { type: 'text', text: m.text },
                  ],
                };
              }
              return { role: 'user', content: m.text };
            });
          },

          scrollChat() {
            this.$nextTick(() => {
              const el = this.$refs.chatScroll;
              if (el) el.scrollTop = el.scrollHeight;
            });
          },

          async sendChatMessage() {
            const text = this.chatInput.trim();
            const img = this.chatImageUrl.trim();
            if (!text && !img) return;
            if (!this.chatModelId) return;

            this.chatMessages.push({ role: 'user', text: text || '(image)', imageUrl: img || null });
            this.chatInput = '';
            this.chatImageUrl = '';
            this.chatShowImage = false;
            this.chatSending = true;
            this.chatStreamText = '';

            const controller = new AbortController();
            this._chatAbort = controller;

            try {
              const resp = await fetch('/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': this.authKey, 'x-models-playground': '1' },
                body: JSON.stringify({
                  model: this.chatModelId,
                  messages: this.buildChatApiMessages(),
                  stream: true,
                }),
                signal: controller.signal,
              });

              if (!resp.ok) {
                const errText = await resp.text();
                this.chatMessages.push({ role: 'assistant', text: '[Error ' + resp.status + '] ' + errText });
                this.chatSending = false;
                this._chatAbort = null;
                this.scrollChat();
                return;
              }

              const reader = resp.body.getReader();
              const decoder = new TextDecoder();
              let buf = '';
              let assistantText = '';
              const idx = this.chatMessages.length;
              this.chatMessages.push({ role: 'assistant', text: '' });

              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\\n');
                buf = lines.pop();
                for (const line of lines) {
                  if (!line.startsWith('data: ')) continue;
                  const payload = line.slice(6);
                  if (payload === '[DONE]') continue;
                  try {
                    const chunk = JSON.parse(payload);
                    const delta = chunk.choices?.[0]?.delta?.content;
                    if (delta) {
                      assistantText += delta;
                      this.chatMessages[idx].text = assistantText;
                    }
                  } catch {}
                }
                this.scrollChat();
              }

              if (!assistantText) {
                this.chatMessages[idx].text = '(empty response)';
              }
            } catch (e) {
              if (e.name !== 'AbortError') {
                this.chatMessages.push({ role: 'assistant', text: '[Error] ' + e.message });
              }
            } finally {
              this.chatSending = false;
              this._chatAbort = null;
              this.scrollChat();
            }
          },

          logout() {
            localStorage.removeItem('authKey');
            localStorage.removeItem('isAdmin');
            localStorage.removeItem('login_key_id');
            localStorage.removeItem('login_key_name');
            localStorage.removeItem('login_key_hint');
            window.location.href = '/';
          },
        };
      }
    </script>
  `;
}
