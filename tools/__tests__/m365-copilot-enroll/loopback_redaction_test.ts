import { request } from 'node:http';

import { describe, expect, it } from 'vitest';

import { listenForM365AuthorizationCode } from '../../src/m365-copilot-enroll/loopback.ts';
import { formatM365AuthError, redactM365AuthText } from '../../src/m365-copilot-enroll/redaction.ts';

const STATE = 'expected-state';

interface CallbackResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
}

const callLoopback = async (input: {
  redirectUri: string;
  method?: string;
  path: string;
  host?: string;
}): Promise<CallbackResponse> => {
  const redirect = new URL(input.redirectUri);
  return await new Promise<CallbackResponse>((resolvePromise, rejectPromise) => {
    const callback = request({
      hostname: '127.0.0.1',
      port: redirect.port,
      method: input.method ?? 'GET',
      path: input.path,
      headers: { host: input.host ?? redirect.host },
    }, response => {
      response.resume();
      response.once('end', () => resolvePromise({ status: response.statusCode ?? 0, headers: response.headers }));
    });
    callback.once('error', rejectPromise);
    callback.end();
  });
};

describe('M365 localhost callback', () => {
  it('redirects the sensitive callback to a clean root and resolves only after that GET', async () => {
    const loopback = await listenForM365AuthorizationCode({ expectedState: STATE, timeoutMs: 1000 });
    expect(loopback.redirectUri).toMatch(/^http:\/\/localhost:\d+\/$/);
    let resolved = false;
    void loopback.authorizationCode.then(() => { resolved = true; });
    const callback = await callLoopback({
      redirectUri: loopback.redirectUri,
      path: `/?code=one-time-code&state=${STATE}`,
    });
    expect(callback).toMatchObject({
      status: 302,
      headers: {
        'cache-control': 'no-store',
        location: '/',
        'referrer-policy': 'no-referrer',
      },
    });
    expect(resolved).toBe(false);
    const clean = await callLoopback({ redirectUri: loopback.redirectUri, path: '/' });
    expect(clean.status).toBe(200);
    expect(clean.headers['referrer-policy']).toBe('no-referrer');
    await expect(loopback.authorizationCode).resolves.toBe('one-time-code');
    await loopback.close();
    await expect(callLoopback({
      redirectUri: loopback.redirectUri,
      path: `/?code=second-code&state=${STATE}`,
    })).rejects.toBeDefined();
  });

  it('rejects extra requests after the OAuth callback without discarding the pending code', async () => {
    const loopback = await listenForM365AuthorizationCode({ expectedState: STATE, timeoutMs: 1000 });
    expect((await callLoopback({
      redirectUri: loopback.redirectUri,
      path: `/?code=one-time-code&state=${STATE}`,
    })).status).toBe(302);
    expect((await callLoopback({ redirectUri: loopback.redirectUri, path: '/favicon.ico' })).status).toBe(400);
    expect((await callLoopback({
      redirectUri: loopback.redirectUri,
      path: `/?code=replacement-code&state=${STATE}`,
    })).status).toBe(400);
    expect((await callLoopback({
      redirectUri: loopback.redirectUri,
      path: `/?error=access_denied&state=${STATE}`,
    })).status).toBe(400);
    let resolved = false;
    void loopback.authorizationCode.then(() => { resolved = true; });
    expect(resolved).toBe(false);
    expect((await callLoopback({ redirectUri: loopback.redirectUri, path: '/' })).status).toBe(200);
    await expect(loopback.authorizationCode).resolves.toBe('one-time-code');
    await loopback.close();
  });

  it.each([
    ['method', { method: 'POST', path: `/?code=code&state=${STATE}` }, 'must use GET'],
    ['path', { path: `/callback?code=code&state=${STATE}` }, 'path is invalid'],
    ['host', { path: `/?code=code&state=${STATE}`, host: '127.0.0.1' }, 'Host header is invalid'],
    ['state', { path: '/?code=code&state=attacker' }, 'state is invalid'],
    ['duplicate code', { path: `/?code=one&code=two&state=${STATE}` }, 'missing, duplicated, or too large'],
    ['URL size', { path: `/?code=${'x'.repeat(20 * 1024)}&state=${STATE}` }, 'invalid or too large'],
  ])('rejects an invalid %s callback', async (_label, requestOptions, message) => {
    const loopback = await listenForM365AuthorizationCode({ expectedState: STATE, timeoutMs: 1000 });
    await expect(callLoopback({ redirectUri: loopback.redirectUri, ...requestOptions })).resolves.toMatchObject({ status: 400 });
    await expect(loopback.authorizationCode).rejects.toThrow(message);
    await loopback.close();
  });

  it('rejects a Microsoft OAuth error without exposing its description', async () => {
    const loopback = await listenForM365AuthorizationCode({ expectedState: STATE, timeoutMs: 1000 });
    await expect(callLoopback({
      redirectUri: loopback.redirectUri,
      path: `/?error=access_denied&error_description=private-details&state=${STATE}`,
    })).resolves.toMatchObject({ status: 302, headers: { location: '/', 'referrer-policy': 'no-referrer' } });
    await expect(callLoopback({ redirectUri: loopback.redirectUri, path: '/' })).resolves.toMatchObject({ status: 400 });
    await expect(loopback.authorizationCode).rejects.toThrow('access_denied');
    await expect(loopback.authorizationCode).rejects.not.toThrow('private-details');
    await loopback.close();
  });

  it('times out and closes the callback server', async () => {
    const loopback = await listenForM365AuthorizationCode({ expectedState: STATE, timeoutMs: 10 });
    await expect(loopback.authorizationCode).rejects.toThrow('Timed out');
    await loopback.close();
  });
});

describe('M365 enrollment redaction', () => {
  it('redacts code-bundle fields, registered secrets, encoded secrets, and causes', () => {
    const secret = 'verifier+/secret';
    const error = new Error(
      `request http://localhost/?code=auth-code&code_verifier=${encodeURIComponent(secret)}`,
      { cause: new Error(`bundle {"authorizationCode":"auth-code","nonce":"nonce-secret"}; ${secret}`) },
    );
    const rendered = formatM365AuthError(error, ['auth-code', 'nonce-secret', secret]);
    expect(rendered).not.toContain('auth-code');
    expect(rendered).not.toContain('nonce-secret');
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain(encodeURIComponent(secret));
    expect(rendered).toContain('[REDACTED]');
    expect(redactM365AuthText('http://localhost/?code_verifier=verifier')).toBe(
      'http://localhost/?code_verifier=[REDACTED]',
    );
  });
});
