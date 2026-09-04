import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { openM365InteractiveBrowser, type M365InteractiveBrowser } from './browser.ts';
import { createM365EnrollmentBundle } from './bundle.ts';
import { M365_COPILOT_ENROLL_HELP, parseM365CopilotEnrollOptions } from './options.ts';
import { prepareM365EnrollmentOutput, type M365EnrollmentOutput } from './output.ts';
import { createM365PkceAuthorization, type M365PkceAuthorization } from './pkce.ts';
import { formatM365AuthError } from './redaction.ts';
import { buildM365AuthorizationUrl } from '@floway-dev/provider-m365-copilot-web/enrollment';

export interface M365EnrollIo {
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
}

export interface M365EnrollDependencies {
  openBrowser(input: { chromiumPath?: string }): Promise<M365InteractiveBrowser>;
  createPkce(): M365PkceAuthorization;
  now(): Date;
  prepareOutput(outputPath: string): Promise<M365EnrollmentOutput>;
}

const defaultDependencies = (): M365EnrollDependencies => ({
  openBrowser: async input => await openM365InteractiveBrowser(input),
  createPkce: createM365PkceAuthorization,
  now: () => new Date(),
  prepareOutput: prepareM365EnrollmentOutput,
});

export const runM365CopilotEnrollCli = async (
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
  io: M365EnrollIo = process,
  dependencies: M365EnrollDependencies = defaultDependencies(),
): Promise<number> => {
  const secrets: string[] = [];
  try {
    const options = parseM365CopilotEnrollOptions(args, environment);
    if ('help' in options) {
      io.stdout.write(M365_COPILOT_ENROLL_HELP);
      return 0;
    }

    const output = await dependencies.prepareOutput(options.outputPath);
    let operationError: unknown;
    try {
      const browser = await dependencies.openBrowser({
        ...(options.chromiumPath === undefined ? {} : { chromiumPath: options.chromiumPath }),
      });
      io.stderr.write('A visible browser has opened. Complete Microsoft sign-in there.\n');
      let bundle: ReturnType<typeof createM365EnrollmentBundle>;
      let authorizationError: unknown;
      try {
        const pkce = dependencies.createPkce();
        secrets.push(pkce.state, pkce.nonce, pkce.codeVerifier);
        const authorizationUrl = buildM365AuthorizationUrl({
          state: pkce.state,
          nonce: pkce.nonce,
          codeChallenge: pkce.codeChallenge,
          ...(options.loginHint === undefined ? {} : { loginHint: options.loginHint }),
        });
        const authorizationCode = await browser.authorize(authorizationUrl, pkce.state);
        secrets.push(authorizationCode);
        bundle = createM365EnrollmentBundle({
          authorizationCode,
          codeVerifier: pkce.codeVerifier,
          nonce: pkce.nonce,
          issuedAt: dependencies.now(),
        });
      } catch (error) {
        authorizationError = error;
        throw error;
      } finally {
        try {
          await browser.close();
        } catch (closeError) {
          if (authorizationError === undefined) throw closeError;
          throw new Error(
            `${formatM365AuthError(authorizationError, secrets)}; browser cleanup failed: ${formatM365AuthError(closeError, secrets)}`,
          );
        }
      }
      await output.write(bundle);
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        await output.dispose();
      } catch (disposeError) {
        if (operationError === undefined) throw disposeError;
        throw new Error(
          `${formatM365AuthError(operationError, secrets)}; output cleanup failed: ${formatM365AuthError(disposeError, secrets)}`,
        );
      }
    }

    io.stdout.write(`M365 enrollment bundle written: ${options.outputPath}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${formatM365AuthError(error, secrets)}\n`);
    return 1;
  }
};

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  process.exitCode = await runM365CopilotEnrollCli(process.argv.slice(2));
}
