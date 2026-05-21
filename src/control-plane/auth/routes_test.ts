import { test } from 'vitest';

import { assertEquals } from '../../test-assert.ts';
import { requestApp, setupAppTest } from '../../test-helpers.ts';

const SECOND_ACCOUNT = {
  token: 'ghu_second_order',
  accountType: 'individual',
  user: {
    id: 4002,
    login: 'second-order',
    name: 'Second Order',
    avatar_url: 'https://example.com/second-order.png',
  },
};

test('/auth/github/order updates GitHub account priority order', async () => {
  const { repo, adminKey, githubAccount } = await setupAppTest();
  await repo.github.saveAccount(SECOND_ACCOUNT.user.id, SECOND_ACCOUNT);

  const response = await requestApp('/auth/github/order', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': adminKey,
    },
    body: JSON.stringify({
      user_ids: [SECOND_ACCOUNT.user.id, githubAccount.user.id],
    }),
  });

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { ok: true });

  const me = await requestApp('/auth/me', {
    headers: { 'x-api-key': adminKey },
  });
  const body = await me.json();
  assertEquals(
    body.accounts.map((account: { id: number }) => account.id),
    [SECOND_ACCOUNT.user.id, githubAccount.user.id],
  );
  assertEquals(
    body.accounts.some((account: Record<string, unknown>) => 'active' in account),
    false,
  );
});
