import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseM365CopilotEnrollOptions } from '../../src/m365-copilot-enroll/options.ts';

describe('M365 Copilot enrollment options', () => {
  it('requires an explicit file destination and resolves it from the invocation directory', () => {
    expect(parseM365CopilotEnrollOptions(
      ['--output', 'private/enrollment.json', '--login-hint', 'operator@example.com'],
      { INIT_CWD: '/workspace' },
    )).toEqual({
      outputPath: resolve('/workspace/private/enrollment.json'),
      loginHint: 'operator@example.com',
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
