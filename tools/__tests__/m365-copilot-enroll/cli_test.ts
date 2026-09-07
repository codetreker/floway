import { describe, expect, it, vi } from 'vitest';

import { runM365CopilotEnrollCli, type M365EnrollDependencies } from '../../src/m365-copilot-enroll/cli.ts';

const STATE = '11111111-1111-4111-8111-111111111111';
const NONCE = 'n'.repeat(43);
const VERIFIER = 'v'.repeat(43);
const CHALLENGE = 'c'.repeat(43);
const REDIRECT_URI = 'http://localhost:49152/';
const AUTHORIZATION_CODE = 'private-authorization-code';

const output = () => {
  let value = '';
  return {
    stream: { write: (chunk: string | Uint8Array) => { value += chunk.toString(); return true; } },
    read: () => value,
  };
};

const successfulDependencies = () => {
  const closeLoopback = vi.fn(async () => undefined);
  const write = vi.fn(async () => undefined);
  const dispose = vi.fn(async () => undefined);
  const createAuthorizationUrl = vi.fn(async () => 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?safe=1');
  const openSystemBrowser = vi.fn(async () => undefined);
  const dependencies: M365EnrollDependencies = {
    createAuthorizationSecrets: async () => ({
      state: STATE,
      nonce: NONCE,
      codeVerifier: VERIFIER,
      codeChallenge: CHALLENGE,
    }),
    createAuthorizationUrl,
    listenForAuthorizationCode: async () => ({
      redirectUri: REDIRECT_URI,
      authorizationCode: Promise.resolve(AUTHORIZATION_CODE),
      close: closeLoopback,
    }),
    now: () => new Date('2026-09-04T00:00:00.000Z'),
    openSystemBrowser,
    prepareOutput: async () => ({ write, dispose }),
  };
  return { dependencies, closeLoopback, createAuthorizationUrl, dispose, openSystemBrowser, write };
};

describe('M365 Copilot enrollment CLI', () => {
  it('opens the system browser and writes only the server-exchange bundle', async () => {
    const stdout = output();
    const stderr = output();
    const { dependencies, closeLoopback, createAuthorizationUrl, dispose, openSystemBrowser, write } = successfulDependencies();

    await expect(runM365CopilotEnrollCli(
      ['--output', 'enrollment.json', '--login-hint', 'operator@example.com'],
      { INIT_CWD: '/workspace' },
      { stdout: stdout.stream, stderr: stderr.stream },
      dependencies,
    )).resolves.toBe(0);

    expect(createAuthorizationUrl).toHaveBeenCalledWith({
      redirectUri: REDIRECT_URI,
      secrets: { state: STATE, nonce: NONCE, codeVerifier: VERIFIER, codeChallenge: CHALLENGE },
      loginHint: 'operator@example.com',
    });
    expect(openSystemBrowser).toHaveBeenCalledWith('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?safe=1');
    expect(write).toHaveBeenCalledWith({
      schema: 'floway.m365-copilot-web-enrollment',
      version: 1,
      issuedAt: '2026-09-04T00:00:00.000Z',
      clientId: '96ff4394-9197-43aa-b393-6a41652e21f8',
      redirectUri: REDIRECT_URI,
      authorizationCode: AUTHORIZATION_CODE,
      codeVerifier: VERIFIER,
      nonce: NONCE,
    });
    expect(closeLoopback).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(stdout.read()).toBe('M365 enrollment bundle written: /workspace/enrollment.json\n');
    expect(stdout.read()).not.toContain(AUTHORIZATION_CODE);
    expect(stderr.read()).not.toContain(AUTHORIZATION_CODE);
    expect(stderr.read()).not.toContain(VERIFIER);
  });

  it('redacts authorization codes and PKCE material from callback failures', async () => {
    const stdout = output();
    const stderr = output();
    const { dependencies } = successfulDependencies();
    dependencies.listenForAuthorizationCode = async () => ({
      redirectUri: REDIRECT_URI,
      authorizationCode: Promise.reject(new Error(`callback failed: ?code=${AUTHORIZATION_CODE}&code_verifier=${VERIFIER}`)),
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

  it('aborts before starting MSAL or the loopback server when private output preparation fails', async () => {
    const stdout = output();
    const stderr = output();
    const { dependencies } = successfulDependencies();
    dependencies.prepareOutput = async () => { throw new Error('private ACL setup failed'); };
    dependencies.createAuthorizationSecrets = vi.fn(dependencies.createAuthorizationSecrets);
    dependencies.listenForAuthorizationCode = vi.fn(dependencies.listenForAuthorizationCode);
    dependencies.openSystemBrowser = vi.fn(dependencies.openSystemBrowser);

    await expect(runM365CopilotEnrollCli(
      ['--output', 'enrollment.json'],
      { INIT_CWD: '/workspace' },
      { stdout: stdout.stream, stderr: stderr.stream },
      dependencies,
    )).resolves.toBe(1);

    expect(dependencies.createAuthorizationSecrets).not.toHaveBeenCalled();
    expect(dependencies.listenForAuthorizationCode).not.toHaveBeenCalled();
    expect(dependencies.openSystemBrowser).not.toHaveBeenCalled();
    expect(stdout.read()).toBe('');
    expect(stderr.read()).toContain('private ACL setup failed');
  });
});
