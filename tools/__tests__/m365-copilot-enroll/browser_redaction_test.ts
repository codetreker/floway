import { describe, expect, it, vi } from 'vitest';

import { openM365InteractiveBrowser, waitForM365AuthorizationCode } from '../../src/m365-copilot-enroll/browser.ts';
import { formatM365AuthError, redactM365AuthText } from '../../src/m365-copilot-enroll/redaction.ts';

interface FakeRequest {
  url(): string;
  isNavigationRequest(): boolean;
}

const createPage = (redirectUrl: string) => {
  const listeners = new Set<(request: FakeRequest) => void>();
  return {
    page: {
      on: (_event: 'request', listener: (request: FakeRequest) => void) => listeners.add(listener),
      off: (_event: 'request', listener: (request: FakeRequest) => void) => listeners.delete(listener),
      goto: vi.fn(async () => {
        for (const listener of listeners) {
          listener({ url: () => redirectUrl, isNavigationRequest: () => true });
        }
      }),
    },
    listeners,
  };
};

describe('M365 browser authorization', () => {
  it('captures the transient nativeclient navigation request after validating state', async () => {
    const { page, listeners } = createPage(
      'https://login.microsoftonline.com/common/oauth2/nativeclient?code=transient-code&state=expected',
    );
    await expect(waitForM365AuthorizationCode({
      page,
      authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=expected',
      expectedState: 'expected',
      timeoutMs: 100,
    })).resolves.toBe('transient-code');
    expect(page.goto).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
  });

  it('rejects a redirect whose state does not belong to the current authorization', async () => {
    const { page } = createPage(
      'https://login.microsoftonline.com/common/oauth2/nativeclient?code=transient-code&state=attacker',
    );
    await expect(waitForM365AuthorizationCode({
      page,
      authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=expected',
      expectedState: 'expected',
      timeoutMs: 100,
    })).rejects.toThrow('invalid OAuth state');
  });

  it('validates state before accepting an OAuth error response', async () => {
    const { page } = createPage(
      'https://login.microsoftonline.com/common/oauth2/nativeclient?error=access_denied&state=attacker',
    );
    await expect(waitForM365AuthorizationCode({
      page,
      authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=expected',
      expectedState: 'expected',
      timeoutMs: 100,
    })).rejects.toThrow('invalid OAuth state');
  });

  it('opens a visible injected Chromium with a non-persistent browser context', async () => {
    const closeContext = vi.fn(async () => undefined);
    const closeBrowser = vi.fn(async () => undefined);
    const newContext = vi.fn(async (options: { viewport: { width: number; height: number } }) => {
      expect(options.viewport).toEqual({ width: 1280, height: 900 });
      return {
        pages: () => [{
          on: () => undefined,
          off: () => undefined,
          goto: async () => undefined,
        }],
        newPage: async () => { throw new Error('not reached'); },
        close: closeContext,
      };
    });
    const launch = vi.fn(async (options: { headless: false }) => {
      expect(options.headless).toBe(false);
      return {
        newContext,
        close: closeBrowser,
      };
    });
    const browser = await openM365InteractiveBrowser({
      chromium: { launch },
      chromiumPath: process.execPath,
    });
    await browser.close();
    expect(launch).toHaveBeenCalledOnce();
    expect(newContext).toHaveBeenCalledOnce();
    expect(closeContext).toHaveBeenCalledOnce();
    expect(closeBrowser).toHaveBeenCalledOnce();
  });
});

describe('M365 auth redaction', () => {
  it('redacts code-bundle fields, registered secrets, encoded secrets, and causes', () => {
    const secret = 'verifier+/secret';
    const error = new Error(
      `request https://login.microsoftonline.com/nativeclient?code=auth-code&code_verifier=${encodeURIComponent(secret)}`,
      { cause: new Error(`bundle {"authorizationCode":"auth-code","nonce":"nonce-secret"}; ${secret}`) },
    );
    const rendered = formatM365AuthError(error, ['auth-code', 'nonce-secret', secret]);
    expect(rendered).not.toContain('auth-code');
    expect(rendered).not.toContain('nonce-secret');
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain(encodeURIComponent(secret));
    expect(rendered).toContain('[REDACTED]');
    expect(redactM365AuthText('https://example.test/?code_verifier=verifier')).toBe(
      'https://example.test/?code_verifier=[REDACTED]',
    );
  });
});
