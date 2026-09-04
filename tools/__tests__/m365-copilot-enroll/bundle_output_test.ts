import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertM365EnrollmentBundle,
  createM365EnrollmentBundle,
  type M365EnrollmentBundle,
} from '../../src/m365-copilot-enroll/bundle.ts';
import {
  prepareM365EnrollmentOutput,
  writeM365EnrollmentBundle,
} from '../../src/m365-copilot-enroll/output.ts';

const temporaryDirectories: string[] = [];
const ISSUED_AT = new Date();

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const bundleFixture = (authorizationCode = 'private-authorization-code'): M365EnrollmentBundle =>
  createM365EnrollmentBundle({
    authorizationCode,
    codeVerifier: 'v'.repeat(86),
    nonce: 'n'.repeat(43),
    issuedAt: ISSUED_AT,
  });

describe('M365 enrollment bundle', () => {
  it('contains only the one-time code exchange material and fixed OAuth identity', () => {
    expect(bundleFixture()).toEqual({
      schema: 'floway.m365-copilot-web-enrollment',
      version: 1,
      issuedAt: ISSUED_AT.toISOString(),
      clientId: '96ff4394-9197-43aa-b393-6a41652e21f8',
      redirectUri: 'https://login.microsoftonline.com/common/oauth2/nativeclient',
      authorizationCode: 'private-authorization-code',
      codeVerifier: 'v'.repeat(86),
      nonce: 'n'.repeat(43),
    });
  });

  it('rejects extra fields and invalid PKCE/nonce material', () => {
    expect(() => assertM365EnrollmentBundle({ ...bundleFixture(), refreshToken: 'must-not-exist' })).toThrow('unexpected key');
    expect(() => assertM365EnrollmentBundle({ ...bundleFixture(), codeVerifier: 'short' })).toThrow('codeVerifier');
    expect(() => assertM365EnrollmentBundle({ ...bundleFixture(), nonce: '' })).toThrow('nonce');
    expect(() => assertM365EnrollmentBundle({ ...bundleFixture(), authorizationCode: 'x'.repeat(16 * 1024 + 1) })).toThrow('authorizationCode');
  });
});

describe('M365 enrollment output', () => {
  it('atomically creates a private file, removes staging state, and refuses replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'floway-m365-enroll-'));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, 'nested', 'enrollment.json');
    const bundle = bundleFixture();

    await writeM365EnrollmentBundle(outputPath, bundle);
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(bundle);
    if (process.platform !== 'win32') expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(directory, 'nested'))).toEqual(['enrollment.json']);

    await expect(writeM365EnrollmentBundle(outputPath, bundleFixture('replacement'))).rejects.toMatchObject({ code: 'EEXIST' });
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual(bundle);
  });

  it('establishes a private Windows DACL before accepting the bundle and preserves it on publication', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'floway-m365-enroll-windows-'));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, 'enrollment.json');
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execute = vi.fn(async (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      return file === 'whoami'
        ? { stdout: '"WORKSTATION\\operator","S-1-5-21-1000"\r\n', stderr: '' }
        : { stdout: 'Successfully processed 1 files', stderr: '' };
    });

    const output = await prepareM365EnrollmentOutput(outputPath, { platform: 'win32', execute });
    expect(calls.map(call => call.file)).toEqual(['whoami', 'icacls', 'icacls']);
    expect(calls[1]?.args).toEqual(expect.arrayContaining(['/grant:r', '*S-1-5-21-1000:(OI)(CI)(F)']));
    expect(calls[2]?.args).toContain('/inheritance:r');

    await output.write(bundleFixture());
    expect(calls.map(call => call.file)).toEqual(['whoami', 'icacls', 'icacls', 'icacls', 'icacls']);
    expect(calls[3]?.args).toEqual(expect.arrayContaining(['/grant:r', '*S-1-5-21-1000:(F)']));
    await output.dispose();
    expect(await readdir(directory)).toEqual(['enrollment.json']);
  });

  it('cleans the staging directory when Windows ACL setup fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'floway-m365-enroll-acl-fail-'));
    temporaryDirectories.push(directory);
    const execute = vi.fn(async (file: string) => {
      if (file === 'whoami') return { stdout: '"WORKSTATION\\operator","S-1-5-21-1000"\r\n', stderr: '' };
      throw new Error('icacls failed');
    });
    await expect(prepareM365EnrollmentOutput(join(directory, 'enrollment.json'), {
      platform: 'win32',
      execute,
    })).rejects.toThrow('icacls failed');
    expect(await readdir(directory)).toEqual([]);
  });
});
