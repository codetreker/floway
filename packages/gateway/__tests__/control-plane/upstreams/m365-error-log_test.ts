import { expect, test } from 'vitest';

import { redactM365ActionErrorForLog } from '../../../src/control-plane/upstreams/m365-error-log.ts';

test('M365 action logging preserves the error chain while redacting credentials and token-bearing URLs', () => {
  const cause = new Error('refresh_token=refresh-secret authorization: Bearer access-secret {"codeVerifier":"verifier-secret"}');
  const error = new Error(
    'request failed at wss://substrate.office.com/chat?access_token=query-secret&code=auth-code',
    { cause },
  );
  const logged = redactM365ActionErrorForLog(error);
  expect(logged).toContain('request failed');
  expect(logged).toContain('Caused by:');
  expect(logged).not.toContain('refresh-secret');
  expect(logged).not.toContain('access-secret');
  expect(logged).not.toContain('query-secret');
  expect(logged).not.toContain('auth-code');
  expect(logged).not.toContain('verifier-secret');
});
