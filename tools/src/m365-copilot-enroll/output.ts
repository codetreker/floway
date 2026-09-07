import { execFile } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { assertM365EnrollmentBundle, type M365EnrollmentBundle } from './bundle.ts';

export interface M365EnrollmentOutput {
  write(bundle: M365EnrollmentBundle): Promise<void>;
  dispose(): Promise<void>;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandExecutor = (file: string, args: readonly string[]) => Promise<CommandResult>;

const executeCommand: CommandExecutor = async (file, args) => await new Promise((resolvePromise, rejectPromise) => {
  execFile(file, [...args], { encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
    if (error) rejectPromise(error);
    else resolvePromise({ stdout, stderr });
  });
});

const existingDestinationError = (outputPath: string): Error => {
  const error = new Error(`Enrollment output already exists: ${outputPath}`) as NodeJS.ErrnoException;
  error.code = 'EEXIST';
  return error;
};

const assertDestinationAbsent = async (outputPath: string): Promise<void> => {
  try {
    await lstat(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw existingDestinationError(outputPath);
};

const readWindowsUserSid = async (execute: CommandExecutor): Promise<string> => {
  const result = await execute('whoami', ['/user', '/fo', 'csv', '/nh']);
  const sid = result.stdout.match(/S-\d-(?:\d+-)+\d+/iu)?.[0];
  if (sid === undefined) throw new Error('Cannot determine the current Windows user SID');
  return sid;
};

const secureWindowsDirectory = async (
  path: string,
  sid: string,
  execute: CommandExecutor,
): Promise<void> => {
  await execute('icacls', [path, '/grant:r', `*${sid}:(OI)(CI)(F)`]);
  await execute('icacls', [path, '/inheritance:r']);
};

const secureWindowsFile = async (
  path: string,
  sid: string,
  execute: CommandExecutor,
): Promise<void> => {
  await execute('icacls', [path, '/grant:r', `*${sid}:(F)`]);
  await execute('icacls', [path, '/inheritance:r']);
};

export const prepareM365EnrollmentOutput = async (
  outputPath: string,
  options: {
    platform?: NodeJS.Platform;
    execute?: CommandExecutor;
  } = {},
): Promise<M365EnrollmentOutput> => {
  const platform = options.platform ?? process.platform;
  const execute = options.execute ?? executeCommand;
  const parent = dirname(outputPath);
  await mkdir(parent, { recursive: true });
  await assertDestinationAbsent(outputPath);

  const stagingDirectory = await mkdtemp(join(parent, `.${basename(outputPath)}.floway-`));
  let disposed = false;
  let written = false;
  let windowsSid: string | undefined;
  try {
    if (platform === 'win32') {
      windowsSid = await readWindowsUserSid(execute);
      await secureWindowsDirectory(stagingDirectory, windowsSid, execute);
    } else {
      await chmod(stagingDirectory, 0o700);
    }
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    write: async bundle => {
      if (disposed) throw new Error('Enrollment output preparation has been disposed');
      if (written) throw new Error('Enrollment bundle has already been written');
      assertM365EnrollmentBundle(bundle);
      await assertDestinationAbsent(outputPath);

      const stagedPath = join(stagingDirectory, 'enrollment.json');
      const file = await open(stagedPath, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      if (platform === 'win32') await secureWindowsFile(stagedPath, windowsSid!, execute);

      await link(stagedPath, outputPath).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw existingDestinationError(outputPath);
        throw error;
      });
      written = true;
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await rm(stagingDirectory, { recursive: true, force: true });
    },
  };
};

export const writeM365EnrollmentBundle = async (
  outputPath: string,
  bundle: M365EnrollmentBundle,
): Promise<void> => {
  const output = await prepareM365EnrollmentOutput(outputPath);
  try {
    await output.write(bundle);
  } finally {
    await output.dispose();
  }
};
