import { describe, expect, it, vi } from 'vitest';

import { runM365CopilotEnrollCli, type M365EnrollDependencies } from '../../src/m365-copilot-enroll/cli.ts';

const STATE = 's'.repeat(43);
const NONCE = 'n'.repeat(43);
const VERIFIER = 'v'.repeat(86);
const CHALLENGE = 'c'.repeat(43);
const AUTHORIZATION_CODE = 'private-authorization-code';

const output = () => {
  let value = '';
  return {
    stream: { write: (chunk: string | Uint8Array) => { value += chunk.toString(); return true; } },
    read: () => value,
  };
};

const successfulDependencies = () => {
  const authorize = vi.fn(async (_authorizationUrl: string, _expectedState: string) => AUTHORIZATION_CODE);
  const closeBrowser = vi.fn(async () => undefined);
  const write = vi.fn(async () => undefined);
  const dispose = vi.fn(async () => undefined);
  const dependencies: M365EnrollDependencies = {
    openBrowser: async () => ({ authorize, close: closeBrowser }),
    createPkce: () => ({ state: STATE, nonce: NONCE, codeVerifier: VERIFIER, codeChallenge: CHALLENGE }),
    now: () => new Date('2026-09-04T00:00:00.000Z'),
    prepareOutput: async () => ({ write, dispose }),
  };
  return { dependencies, authorize, closeBrowser, write, dispose };
};

describe('M365 Copilot enrollment CLI', () => {
  it('writes only a short-lived code bundle and prints destination status', async () => {
    const stdout = output();
    const stderr = output();
    const { dependencies, authorize, closeBrowser, write, dispose } = successfulDependencies();

    await expect(runM365CopilotEnrollCli(
      ['--output', 'enrollment.json', '--login-hint', 'operator@example.com'],
      { INIT_CWD: '/workspace' },
      { stdout: stdout.stream, stderr: stderr.stream },
      dependencies,
    )).resolves.toBe(0);

    const [authorizationUrl, expectedState] = authorize.mock.calls[0]!;
    const parsedAuthorizationUrl = new URL(authorizationUrl);
    expect(expectedState).toBe(STATE);
    expect(parsedAuthorizationUrl.searchParams.get('state')).toBe(STATE);
    expect(parsedAuthorizationUrl.searchParams.get('nonce')).toBe(NONCE);
    expect(parsedAuthorizationUrl.searchParams.get('code_challenge')).toBe(CHALLENGE);
    expect(parsedAuthorizationUrl.searchParams.get('login_hint')).toBe('operator@example.com');
    expect(write).toHaveBeenCalledWith({
      schema: 'floway.m365-copilot-web-enrollment',
      version: 1,
      issuedAt: '2026-09-04T00:00:00.000Z',
      clientId: '96ff4394-9197-43aa-b393-6a41652e21f8',
      redirectUri: 'https://login.microsoftonline.com/common/oauth2/nativeclient',
      authorizationCode: AUTHORIZATION_CODE,
      codeVerifier: VERIFIER,
      nonce: NONCE,
    });
    expect(closeBrowser).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(stdout.read()).toBe('M365 enrollment bundle written: /workspace/enrollment.json\n');
    expect(stdout.read()).not.toContain(AUTHORIZATION_CODE);
    expect(stderr.read()).not.toContain(AUTHORIZATION_CODE);
    expect(stderr.read()).not.toContain(VERIFIER);
  });

  it('redacts authorization codes and PKCE material from failures', async () => {
    const stdout = output();
    const stderr = output();
    const { dependencies } = successfulDependencies();
    dependencies.openBrowser = async () => ({
      authorize: async () => {
        throw new Error(`redirect failed: ?code=${AUTHORIZATION_CODE}&code_verifier=${VERIFIER}`);
      },
      close: async () => undefined,
    });

    await expect(runM365CopilotEnrollCli(
      ['--output', 'enrollment.json'],
      { INIT_CWD: '/workspace' },
      { stdout: stdout.stream, stderr: stderr.stream },
      dependencies,
    )).resolves.toBe(1);

    expect(stdout.read()).toBe('');
    expect(stderr.read()).not.toContain(AUTHORIZATION_CODE);
    expect(stderr.read()).not.toContain(VERIFIER);
    expect(stderr.read()).toContain('[REDACTED]');
  });

  it('aborts before opening a browser when private output preparation fails', async () => {
    const stdout = output();
    const stderr = output();
    const { dependencies } = successfulDependencies();
    dependencies.prepareOutput = async () => { throw new Error('private ACL setup failed'); };
    dependencies.openBrowser = vi.fn(dependencies.openBrowser);

    await expect(runM365CopilotEnrollCli(
      ['--output', 'enrollment.json'],
      { INIT_CWD: '/workspace' },
      { stdout: stdout.stream, stderr: stderr.stream },
      dependencies,
    )).resolves.toBe(1);

    expect(dependencies.openBrowser).not.toHaveBeenCalled();
    expect(stdout.read()).toBe('');
    expect(stderr.read()).toContain('private ACL setup failed');
  });
});
