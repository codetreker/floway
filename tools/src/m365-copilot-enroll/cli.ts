import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createM365AuthorizationSecrets,
  createM365AuthorizationUrl,
  openM365SystemBrowser,
  type M365AuthorizationSecrets,
} from './authorization.ts';
import { createM365EnrollmentBundle } from './bundle.ts';
import { listenForM365AuthorizationCode, type M365LoopbackAuthorization } from './loopback.ts';
import { M365_COPILOT_ENROLL_HELP, parseM365CopilotEnrollOptions } from './options.ts';
import { prepareM365EnrollmentOutput, type M365EnrollmentOutput } from './output.ts';
import { formatM365AuthError } from './redaction.ts';
import type { M365LoopbackRedirectUri } from '@floway-dev/provider-m365-copilot-web/enrollment';

export interface M365EnrollIo {
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
}

export interface M365EnrollDependencies {
  createAuthorizationSecrets(): Promise<M365AuthorizationSecrets>;
  createAuthorizationUrl(input: {
    redirectUri: M365LoopbackRedirectUri;
    secrets: M365AuthorizationSecrets;
    loginHint?: string;
  }): Promise<string>;
  listenForAuthorizationCode(input: { expectedState: string }): Promise<M365LoopbackAuthorization>;
  now(): Date;
  openSystemBrowser(authorizationUrl: string): Promise<void>;
  prepareOutput(outputPath: string): Promise<M365EnrollmentOutput>;
}

const defaultDependencies = (): M365EnrollDependencies => ({
  createAuthorizationSecrets: createM365AuthorizationSecrets,
  createAuthorizationUrl: async input => await createM365AuthorizationUrl(input),
  listenForAuthorizationCode: listenForM365AuthorizationCode,
  now: () => new Date(),
  openSystemBrowser: openM365SystemBrowser,
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
      const secretsForAuthorization = await dependencies.createAuthorizationSecrets();
      secrets.push(
        secretsForAuthorization.state,
        secretsForAuthorization.nonce,
        secretsForAuthorization.codeVerifier,
        secretsForAuthorization.codeChallenge,
      );
      const callback = await dependencies.listenForAuthorizationCode({
        expectedState: secretsForAuthorization.state,
      });
      let bundle: ReturnType<typeof createM365EnrollmentBundle>;
      let authorizationError: unknown;
      try {
        const authorizationUrl = await dependencies.createAuthorizationUrl({
          redirectUri: callback.redirectUri,
          secrets: secretsForAuthorization,
          ...(options.loginHint === undefined ? {} : { loginHint: options.loginHint }),
        });
        await dependencies.openSystemBrowser(authorizationUrl);
        io.stderr.write('Opened the default system browser for MSAL sign-in. Complete Microsoft sign-in there.\n');
        const authorizationCode = await callback.authorizationCode;
        secrets.push(authorizationCode);
        bundle = createM365EnrollmentBundle({
          authorizationCode,
          codeVerifier: secretsForAuthorization.codeVerifier,
          nonce: secretsForAuthorization.nonce,
          redirectUri: callback.redirectUri,
          issuedAt: dependencies.now(),
        });
      } catch (error) {
        authorizationError = error;
        throw error;
      } finally {
        try {
          await callback.close();
        } catch (closeError) {
          if (authorizationError === undefined) throw closeError;
          throw new Error(
            `${formatM365AuthError(authorizationError, secrets)}; loopback cleanup failed: ${formatM365AuthError(closeError, secrets)}`,
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
