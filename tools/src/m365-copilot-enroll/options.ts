import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

export interface M365CopilotEnrollOptions {
  outputPath: string;
  loginHint?: string;
  chromiumPath?: string;
}

export const M365_COPILOT_ENROLL_HELP = `Usage:
  pnpm --silent tools:m365-copilot-enroll --output <enrollment.json> [--login-hint <email>]

Options:
  --output <file>       New file that will receive the one-time enrollment bundle.
  --login-hint <email>  Preselect an account on the Microsoft sign-in page.
  --help                Show this help.

Environment:
  CHROMIUM_PATH         System Chromium, Chrome, or Edge executable to open.

The bundle contains a one-time authorization code and PKCE verifier. Import it
into the intended Floway instance within five minutes, then delete it. This
helper never receives Microsoft access, refresh, or ID tokens and does not
accept Floway administrator credentials.
`;

const requiredValue = (value: string | undefined, name: string): string => {
  if (value === undefined || value.trim().length === 0) throw new TypeError(`--${name} requires a value`);
  return value;
};

export const parseM365CopilotEnrollOptions = (
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
  cwd = environment.INIT_CWD ?? process.cwd(),
): M365CopilotEnrollOptions | { help: true } => {
  const parsed = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      output: { type: 'string' },
      'login-hint': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (parsed.values.help) return { help: true };

  const requestedOutput = requiredValue(parsed.values.output, 'output');
  if (requestedOutput === '-') throw new TypeError('--output must name a file; stdout is not an enrollment destination');
  const loginHint = parsed.values['login-hint']?.trim();
  const chromiumPath = environment.CHROMIUM_PATH?.trim();
  return {
    outputPath: resolve(cwd, requestedOutput),
    ...(loginHint ? { loginHint } : {}),
    ...(chromiumPath ? { chromiumPath } : {}),
  };
};
