import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { M365_OAUTH_REDIRECT_URI } from '@floway-dev/provider-m365-copilot-web/enrollment';

const AUTHORIZATION_TIMEOUT_MS = 10 * 60 * 1000;

const SYSTEM_CHROMIUM_PATHS = process.platform === 'darwin'
  ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  : process.platform === 'win32'
    ? [
        ...(process.env.PROGRAMFILES ? [join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe')] : []),
        ...(process.env['PROGRAMFILES(X86)'] ? [join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe')] : []),
        ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')] : []),
      ]
    : [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/microsoft-edge',
        '/usr/bin/microsoft-edge-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
      ];

interface BrowserRequest {
  url(): string;
  isNavigationRequest?(): boolean;
}

interface BrowserPage {
  goto(url: string, options: { waitUntil: 'domcontentloaded' }): Promise<unknown>;
  on(event: 'request', listener: (request: BrowserRequest) => void): void;
  off(event: 'request', listener: (request: BrowserRequest) => void): void;
}

interface BrowserContext {
  pages(): BrowserPage[];
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

interface Browser {
  newContext(options: { viewport: { width: number; height: number } }): Promise<BrowserContext>;
  close(): Promise<void>;
}

export interface PlaywrightChromium {
  launch(
    options: {
      headless: false;
      executablePath?: string;
      channel?: 'chrome' | 'msedge';
    },
  ): Promise<Browser>;
}

export interface M365InteractiveBrowser {
  authorize(authorizationUrl: string, expectedState: string): Promise<string>;
  close(): Promise<void>;
}

const existsAndExecutable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const loadPlaywrightChromium = async (): Promise<PlaywrightChromium> => {
  const packageName = 'playwright-core';
  const loaded = await import(packageName) as { chromium?: PlaywrightChromium };
  if (loaded.chromium === undefined) throw new Error('playwright-core does not export chromium');
  return loaded.chromium;
};

const launchBrowser = async (
  chromium: PlaywrightChromium,
  configuredPath?: string,
): Promise<Browser> => {
  const common = { headless: false as const };
  if (configuredPath !== undefined) {
    if (!await existsAndExecutable(configuredPath)) throw new Error(`CHROMIUM_PATH is not an executable file: ${configuredPath}`);
    return await chromium.launch({ ...common, executablePath: configuredPath });
  }

  const failures: string[] = [];
  for (const executablePath of SYSTEM_CHROMIUM_PATHS) {
    if (await existsAndExecutable(executablePath)) {
      try {
        return await chromium.launch({ ...common, executablePath });
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  for (const channel of ['chrome', 'msedge'] as const) {
    try {
      return await chromium.launch({ ...common, channel });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`No system Chromium installation was found. Set CHROMIUM_PATH. Browser probes failed: ${failures.join('; ')}`);
};

export const waitForM365AuthorizationCode = async (input: {
  page: BrowserPage;
  authorizationUrl: string;
  expectedState: string;
  timeoutMs?: number;
}): Promise<string> => {
  const redirect = new URL(M365_OAUTH_REDIRECT_URI);
  let settled = false;
  let resolveCapture!: (code: string) => void;
  let rejectCapture!: (error: Error) => void;
  const captured = new Promise<string>((resolvePromise, rejectPromise) => {
    resolveCapture = resolvePromise;
    rejectCapture = rejectPromise;
  });

  const listener = (request: BrowserRequest): void => {
    if (request.isNavigationRequest?.() === false) return;
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (url.origin !== redirect.origin || url.pathname !== redirect.pathname) return;
    const oauthError = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (oauthError === null && code === null) return;
    if (url.searchParams.get('state') !== input.expectedState) {
      settled = true;
      rejectCapture(new Error('Microsoft authorization returned an invalid OAuth state'));
      return;
    }
    if (oauthError !== null) {
      settled = true;
      rejectCapture(new Error(`Microsoft authorization failed with ${oauthError}`));
      return;
    }
    settled = true;
    resolveCapture(code!);
  };

  input.page.on('request', listener);
  const navigation = input.page.goto(input.authorizationUrl, { waitUntil: 'domcontentloaded' });
  void navigation.catch(error => {
    if (!settled) rejectCapture(error instanceof Error ? error : new Error(String(error)));
  });
  const timer = setTimeout(
    () => rejectCapture(new Error('Timed out waiting for Microsoft authorization')),
    input.timeoutMs ?? AUTHORIZATION_TIMEOUT_MS,
  );
  try {
    return await captured;
  } finally {
    clearTimeout(timer);
    input.page.off('request', listener);
  }
};

export const openM365InteractiveBrowser = async (input: {
  chromiumPath?: string;
  chromium?: PlaywrightChromium;
} = {}): Promise<M365InteractiveBrowser> => {
  const browser = await launchBrowser(input.chromium ?? await loadPlaywrightChromium(), input.chromiumPath);
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = context.pages()[0] ?? await context.newPage();
    return {
      authorize: async (authorizationUrl, expectedState) => await waitForM365AuthorizationCode({
        page,
        authorizationUrl,
        expectedState,
      }),
      close: async () => {
        try {
          await context!.close();
        } finally {
          await browser.close();
        }
      },
    };
  } catch (error) {
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    throw error;
  }
};
