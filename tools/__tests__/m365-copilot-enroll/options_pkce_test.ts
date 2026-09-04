import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseM365CopilotEnrollOptions } from '../../src/m365-copilot-enroll/options.ts';
import { createM365PkceAuthorization } from '../../src/m365-copilot-enroll/pkce.ts';

describe('M365 Copilot enrollment options', () => {
  it('requires an explicit file destination and resolves it from the invocation directory', () => {
    expect(parseM365CopilotEnrollOptions(
      ['--output', 'private/enrollment.json', '--login-hint', 'operator@example.com'],
      { INIT_CWD: '/workspace', CHROMIUM_PATH: '/opt/chromium' },
    )).toEqual({
      outputPath: resolve('/workspace/private/enrollment.json'),
      loginHint: 'operator@example.com',
      chromiumPath: '/opt/chromium',
    });
    expect(() => parseM365CopilotEnrollOptions([], {}, '/workspace')).toThrow('--output');
    expect(() => parseM365CopilotEnrollOptions(['--output', '-'], {}, '/workspace')).toThrow('stdout');
  });

  it('does not accept account secrets or Floway administrator credentials', () => {
    expect(() => parseM365CopilotEnrollOptions(
      ['--output', 'enrollment.json', '--password', 'secret'],
      {},
      '/workspace',
    )).toThrow('Unknown option');
    expect(() => parseM365CopilotEnrollOptions(
      ['--output', 'enrollment.json', '--totp', '123456'],
      {},
      '/workspace',
    )).toThrow('Unknown option');
    expect(() => parseM365CopilotEnrollOptions(
      ['--output', 'enrollment.json', '--floway-token', 'admin-secret'],
      {},
      '/workspace',
    )).toThrow('Unknown option');
  });
});

describe('M365 Copilot PKCE', () => {
  it('creates independent high-entropy state and S256 verifier material', () => {
    const first = createM365PkceAuthorization();
    const second = createM365PkceAuthorization();
    expect(first.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.codeVerifier).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(first.codeChallenge).toBe(createHash('sha256').update(first.codeVerifier, 'ascii').digest('base64url'));
    expect(second.state).not.toBe(first.state);
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.codeVerifier).not.toBe(first.codeVerifier);
  });
});
