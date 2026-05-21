import { getRepo } from '../repo/index.ts';

const COPILOT_BASE_URLS: Record<string, string> = {
  individual: 'https://api.githubcopilot.com',
  business: 'https://api.business.githubcopilot.com',
  enterprise: 'https://api.enterprise.githubcopilot.com',
};

const COPILOT_VERSION = '0.38.2';
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`;
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`;
const FALLBACK_EDITOR_VERSION = 'vscode/1.110.1';
const API_VERSION = '2025-10-01';

const isCopilotTokenFetchTerminalStatus = (status: number): boolean => status === 403 || status === 429 || status === 500;

const VSCODE_VERSION_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
let cachedVSCodeVersion: string | null = null;
let vscodeVersionExpiresAt = 0;

// Two-level Copilot token cache: in-process (60s) + KV (cross-datacenter).
// In-process avoids KV reads on every request. KV avoids HTTP fetches on cold starts.
const LEGACY_COPILOT_TOKEN_KV_KEY = 'copilot_token';
const COPILOT_TOKEN_KV_KEY_PREFIX = 'copilot_token_v2';
const IN_PROCESS_TTL_MS = 60_000;
const inProcessTokenCache = new Map<
  string,
  {
    entry: CopilotTokenCacheEntry;
    cachedAt: number;
  }
>();

interface CopilotTokenCacheEntry {
  token: string;
  expiresAt: number;
}

export class CopilotTokenFetchError extends Error {
  constructor(readonly status: number, readonly body: string, readonly headers: Headers) {
    super(`Copilot token fetch failed: ${status} ${body}`);
    this.name = 'CopilotTokenFetchError';
  }
}

export const isCopilotTokenFetchError = (error: unknown): error is CopilotTokenFetchError => error instanceof CopilotTokenFetchError;

/** Clear the cached Copilot token from both in-process and KV storage */
export async function clearCopilotTokenCache(): Promise<void> {
  inProcessTokenCache.clear();
  try {
    await getRepo().cache.delete(LEGACY_COPILOT_TOKEN_KV_KEY);
    await getRepo().cache.deletePrefix(`${COPILOT_TOKEN_KV_KEY_PREFIX}:`);
  } catch {
    // Ignore — KV may not be available during initialization
  }
}

function copilotBaseUrl(accountType: string): string {
  return COPILOT_BASE_URLS[accountType] ?? COPILOT_BASE_URLS.individual;
}

async function fetchVSCodeVersion(): Promise<string> {
  const now = Date.now();
  if (cachedVSCodeVersion && vscodeVersionExpiresAt > now) {
    return cachedVSCodeVersion;
  }

  try {
    const resp = await fetch('https://update.code.visualstudio.com/api/releases/stable', { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const releases = (await resp.json()) as string[];
    if (Array.isArray(releases) && releases.length > 0 && typeof releases[0] === 'string') {
      cachedVSCodeVersion = releases[0];
      vscodeVersionExpiresAt = now + VSCODE_VERSION_TTL_MS;
      return cachedVSCodeVersion;
    }
    throw new Error('Invalid response format');
  } catch (e) {
    console.warn(`Failed to fetch VS Code version: ${e instanceof Error ? e.message : String(e)}, using fallback`);
    return cachedVSCodeVersion ?? FALLBACK_EDITOR_VERSION.replace('vscode/', '');
  }
}

async function getEditorVersion(): Promise<string> {
  return `vscode/${await fetchVSCodeVersion()}`;
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelayMs = 1000): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      // Don't retry client errors (4xx) — they won't change on retry
      if (isCopilotTokenFetchError(e) && isCopilotTokenFetchTerminalStatus(e.status)) {
        throw e;
      }
      if (e instanceof Error && /failed: 4\d{2} /.test(e.message)) throw e;
      if (attempt >= maxRetries) throw e;
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${e instanceof Error ? e.message : String(e)}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
}

function isTokenValid(token: string | null, expiresAt: number): boolean {
  if (!token) return false;
  const now = Math.floor(Date.now() / 1000);
  return expiresAt > now + 60;
}

async function copilotTokenCacheKey(githubToken: string, accountType: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${accountType}:${githubToken}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `${COPILOT_TOKEN_KV_KEY_PREFIX}:${hash}`;
}

async function getCopilotToken(githubToken: string): Promise<string> {
  const cacheKey = await copilotTokenCacheKey(githubToken, 'copilot');

  // Level 1: in-process cache (avoids KV read on hot path)
  const now = Date.now();
  const cached = inProcessTokenCache.get(cacheKey);
  if (cached && isTokenValid(cached.entry.token, cached.entry.expiresAt) && now - cached.cachedAt < IN_PROCESS_TTL_MS) {
    return cached.entry.token;
  }

  // Level 2: KV cache (cross-datacenter, survives isolate restarts)
  try {
    const raw = await getRepo().cache.get(cacheKey);
    if (raw) {
      const entry = JSON.parse(raw) as CopilotTokenCacheEntry;
      if (isTokenValid(entry.token, entry.expiresAt)) {
        inProcessTokenCache.set(cacheKey, { entry, cachedAt: now });
        return entry.token;
      }
    }
  } catch {
    // KV read failure is non-fatal — fall through to fetch
  }

  // Level 3: fetch from GitHub API
  return await withRetry(async () => {
    const editorVer = await getEditorVersion();
    const resp = await fetch('https://api.github.com/copilot_internal/v2/token', {
      headers: {
        authorization: `token ${githubToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'editor-version': editorVer,
        'editor-plugin-version': EDITOR_PLUGIN_VERSION,
        'user-agent': USER_AGENT,
        'x-github-api-version': API_VERSION,
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new CopilotTokenFetchError(resp.status, text, new Headers(resp.headers));
    }

    const data = (await resp.json()) as {
      token: string;
      expires_at: number;
      refresh_in: number;
    };

    const entry: CopilotTokenCacheEntry = {
      token: data.token,
      expiresAt: data.expires_at,
    };
    inProcessTokenCache.set(cacheKey, { entry, cachedAt: Date.now() });
    getRepo()
      .cache.set(cacheKey, JSON.stringify(entry))
      .catch(() => {});

    return data.token;
  });
}

export interface CopilotFetchOptions {
  vision?: boolean;
  initiator?: 'user' | 'agent';
  extraHeaders?: Record<string, string>;
}

export async function copilotFetch(path: string, init: RequestInit, githubToken: string, accountType: string, options?: CopilotFetchOptions): Promise<Response> {
  const token = await getCopilotToken(githubToken);
  const baseUrl = copilotBaseUrl(accountType);
  const editorVer = await getEditorVersion();

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Content-Type', 'application/json');
  headers.set('editor-version', editorVer);
  headers.set('editor-plugin-version', EDITOR_PLUGIN_VERSION);
  headers.set('user-agent', USER_AGENT);
  headers.set('x-github-api-version', API_VERSION);
  headers.set('copilot-integration-id', 'vscode-chat');
  headers.set('openai-intent', 'conversation-agent');
  headers.set('x-interaction-type', 'conversation-agent');

  if (options?.vision) headers.set('copilot-vision-request', 'true');
  if (options?.initiator) headers.set('X-Initiator', options.initiator);
  if (options?.extraHeaders) {
    for (const [k, v] of Object.entries(options.extraHeaders)) {
      headers.set(k, v);
    }
  }

  return await fetch(`${baseUrl}${path}`, { ...init, headers });
}

export async function githubHeaders(githubToken: string): Promise<Record<string, string>> {
  const editorVer = await getEditorVersion();
  return {
    authorization: `token ${githubToken}`,
    'content-type': 'application/json',
    accept: 'application/json',
    'editor-version': editorVer,
    'editor-plugin-version': EDITOR_PLUGIN_VERSION,
    'user-agent': USER_AGENT,
    'x-github-api-version': API_VERSION,
  };
}
