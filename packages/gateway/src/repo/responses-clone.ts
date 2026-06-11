import type { StoredResponsesItem, StoredResponsesSnapshot } from './types.ts';

export const cloneStoredResponsesItem = (item: StoredResponsesItem): StoredResponsesItem => ({
  ...item,
  payload: item.payload === null ? null : structuredClone(item.payload),
});

export const cloneStoredResponsesSnapshot = (snapshot: StoredResponsesSnapshot): StoredResponsesSnapshot => ({
  ...snapshot,
  itemIds: [...snapshot.itemIds],
});

export const responsesItemStoreKey = (apiKeyId: string | null, id: string): string =>
  `${apiKeyId ?? ''}\0${id}`;

export const compareResponsesItemsByFreshness = (a: StoredResponsesItem, b: StoredResponsesItem): number =>
  b.refreshedAt - a.refreshedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
