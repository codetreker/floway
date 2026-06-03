import { createStoredResponsesItemId, hashResponsesItemContent, hashResponsesItemEncryptedContent, isStoredResponsesItemId, responsesItemEncryptedContent, responsesItemId } from './items/format.ts';
import { getRepo } from '../../../../repo/index.ts';
import type { Repo, StoredResponsesItem, StoredResponsesSnapshot } from '../../../../repo/types.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
import type { ResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export interface StatefulResponsesStore {
  loadSnapshot(id: string): Promise<StoredResponsesSnapshot | null>;
  loadInputItems<TSourceItems>(options: {
    readonly sourceItems: TSourceItems;
    readonly view: Pick<ResponsesItemsView<TSourceItems>, 'visitAsResponsesItems'>;
    readonly inputItemsToStage?: readonly ResponsesInputItem[];
  }): Promise<void>;
  getItemById(id: string): StoredResponsesItem | undefined;
  getItemsByEncryptedContentHash(hash: string): StoredResponsesItem[];
  touchItem(id: string): void;
  stageInputItems(items: readonly ResponsesInputItem[]): Promise<void>;
  beginAttempt(references: Iterable<{ readonly row?: StoredResponsesItem }>): void;
  addSyntheticItem(id: string, privatePayload?: unknown): void;
  isSyntheticItem(id: string): boolean;
  getPrivatePayload(id: string): unknown;
  stageOutputItem(row: StoredResponsesItem): void;
  commitOutputItems(): Promise<void>;
  commitSnapshot(responseId: string): Promise<void>;
  refreshTouchedItems(): Promise<void>;
}

class HttpStatefulResponsesStore implements StatefulResponsesStore {
  private readonly loadedItemsById = new Map<string, StoredResponsesItem>();
  private readonly loadedItemsByContentHash = new Map<string, StoredResponsesItem[]>();
  private readonly loadedItemsByEncryptedContentHash = new Map<string, StoredResponsesItem[]>();
  private readonly privatePayload = new Map<string, unknown>();
  private readonly syntheticItemIds = new Set<string>();
  private readonly snapshotsById = new Map<string, StoredResponsesSnapshot>();
  private readonly stagedInputItems = new Map<string, StoredResponsesItem>();
  private readonly stagedInputItemIds: string[] = [];
  private previousSnapshotItemIds: string[] = [];
  private readonly stagedOutputItems = new Map<string, StoredResponsesItem>();
  private readonly stagedOutputItemIds: string[] = [];
  private readonly committedItemIds = new Set<string>();
  private readonly payloadUpgradeIds = new Set<string>();
  private readonly committedSnapshotIds = new Set<string>();
  private readonly touchedItemIds = new Set<string>();
  private readonly refreshedItemIds = new Set<string>();

  constructor(
    private readonly repoProvider: Repo | (() => Repo),
    private readonly apiKeyId: string | null,
    private readonly store: boolean | null | undefined,
  ) {}

  private get repo(): Repo {
    return typeof this.repoProvider === 'function' ? this.repoProvider() : this.repoProvider;
  }

  async loadSnapshot(id: string): Promise<StoredResponsesSnapshot | null> {
    const cached = this.snapshotsById.get(id);
    if (cached) {
      this.previousSnapshotItemIds = [...cached.itemIds];
      return cloneStoredResponsesSnapshot(cached);
    }

    const snapshot = await this.repo.responsesSnapshots.lookup(this.apiKeyId, id);
    if (snapshot === null) return null;
    await this.loadItems({ ids: snapshot.itemIds, contentHashes: [], encryptedContentHashes: [] });
    if (!snapshot.itemIds.every(itemId => {
      const row = this.loadedItemsById.get(itemId);
      return row !== undefined && isReplayableSnapshotRow(row);
    })) return null;
    this.rememberSnapshot(snapshot);
    this.previousSnapshotItemIds = [...snapshot.itemIds];
    for (const itemId of snapshot.itemIds) this.touchedItemIds.add(itemId);
    await this.repo.responsesSnapshots.refresh(this.apiKeyId, id, Date.now());
    return cloneStoredResponsesSnapshot(snapshot);
  }

  async loadInputItems<TSourceItems>(options: {
    readonly sourceItems: TSourceItems;
    readonly view: Pick<ResponsesItemsView<TSourceItems>, 'visitAsResponsesItems'>;
    readonly inputItemsToStage?: readonly ResponsesInputItem[];
  }): Promise<void> {
    const ids = new Set<string>();
    const encryptedContents = new Set<string>();
    await options.view.visitAsResponsesItems(options.sourceItems, item => {
      const id = responsesItemId(item);
      if (id !== null && isStoredResponsesItemId(id)) ids.add(id);
      const encryptedContent = responsesItemEncryptedContent(item);
      if (encryptedContent !== null) encryptedContents.add(encryptedContent);
    });

    const contentHashes = new Set<string>();
    for (const item of options.inputItemsToStage ?? []) contentHashes.add(await hashResponsesItemContent(item));

    const encryptedContentHashes = new Set<string>();
    for (const encryptedContent of encryptedContents) encryptedContentHashes.add(await hashResponsesItemEncryptedContent(encryptedContent));

    await this.loadItems({
      ids: [...ids],
      contentHashes: [...contentHashes],
      encryptedContentHashes: [...encryptedContentHashes],
    });
  }

  getItemById(id: string): StoredResponsesItem | undefined {
    const row = this.loadedItemsById.get(id) ?? this.stagedInputItems.get(id) ?? this.stagedOutputItems.get(id);
    if (row) this.touchItem(row.id);
    return row ? cloneStoredResponsesItem(row) : undefined;
  }

  getItemsByEncryptedContentHash(hash: string): StoredResponsesItem[] {
    return (this.loadedItemsByEncryptedContentHash.get(hash) ?? []).map(cloneStoredResponsesItem);
  }

  touchItem(id: string): void {
    this.touchedItemIds.add(id);
  }

  async stageInputItems(items: readonly ResponsesInputItem[]): Promise<void> {
    if (this.store === false) return;
    for (const item of items) await this.stageInputItem(item);
  }

  beginAttempt(references: Iterable<{ readonly row?: StoredResponsesItem }>): void {
    this.stagedOutputItems.clear();
    this.stagedOutputItemIds.length = 0;
    this.privatePayload.clear();
    this.syntheticItemIds.clear();
    for (const ref of references) {
      if (ref.row?.payload?.private === undefined) continue;
      const wireId = responsesItemId(ref.row.payload.item as { id?: unknown });
      if (wireId !== null) this.privatePayload.set(wireId, ref.row.payload.private);
    }
  }

  addSyntheticItem(id: string, privatePayload?: unknown): void {
    this.syntheticItemIds.add(id);
    if (privatePayload !== undefined) this.privatePayload.set(id, privatePayload);
  }

  isSyntheticItem(id: string): boolean {
    return this.syntheticItemIds.has(id);
  }

  getPrivatePayload(id: string): unknown {
    return this.privatePayload.get(id);
  }

  stageOutputItem(row: StoredResponsesItem): void {
    const cloned = cloneStoredResponsesItem(row);
    this.stagedOutputItems.set(cloned.id, cloned);
    this.stagedOutputItemIds.push(cloned.id);
    this.rememberItem(cloned);
  }

  async commitOutputItems(): Promise<void> {
    await this.commitItems([...this.stagedOutputItems.values()]);
  }

  async commitSnapshot(responseId: string): Promise<void> {
    if (this.store === false || this.committedSnapshotIds.has(responseId)) return;
    await this.commitItems([...this.stagedInputItems.values(), ...this.stagedOutputItems.values()]);
    const itemIds = [...this.previousSnapshotItemIds, ...this.stagedInputItemIds, ...this.stagedOutputItemIds];
    if (itemIds.length === 0) return;

    const replayableRows = this.replayableRowsForSnapshot(itemIds);
    await this.commitItems(replayableRows);
    const now = Date.now();
    const snapshot: StoredResponsesSnapshot = {
      id: responseId,
      apiKeyId: this.apiKeyId,
      itemIds,
      createdAt: now,
      refreshedAt: now,
    };
    await this.repo.responsesSnapshots.insert(snapshot);
    this.rememberSnapshot(snapshot);
    this.committedSnapshotIds.add(responseId);
  }

  private async loadItems(query: { ids: readonly string[]; contentHashes: readonly string[]; encryptedContentHashes: readonly string[] }): Promise<void> {
    const ids = query.ids.filter(id => !this.loadedItemsById.has(id));
    const contentHashes = query.contentHashes.filter(hash => !this.loadedItemsByContentHash.has(hash));
    const encryptedContentHashes = query.encryptedContentHashes.filter(hash => !this.loadedItemsByEncryptedContentHash.has(hash));
    const [byId, byContentHash, byEncryptedContentHash] = await Promise.all([
      this.repo.responsesItems.lookupMany(this.apiKeyId, ids),
      this.repo.responsesItems.lookupManyByContentHash(this.apiKeyId, contentHashes),
      this.repo.responsesItems.lookupManyByEncryptedContentHash(this.apiKeyId, encryptedContentHashes),
    ]);
    for (const row of [...byId, ...byContentHash, ...byEncryptedContentHash]) this.rememberItem(row);
  }

  private async stageInputItem(item: ResponsesInputItem): Promise<void> {
    if (item.type === 'item_reference') {
      const row = this.getItemById(item.id);
      if (row === undefined) throw new Error(`Cannot stage unresolved Responses item_reference id=${item.id}`);
      this.stagedInputItemIds.push(row.id);
      return;
    }

    const storedId = responsesItemId(item);
    if (storedId !== null && isStoredResponsesItemId(storedId)) {
      const row = this.getItemById(storedId);
      if (row !== undefined) {
        if (row.payload !== null) {
          this.stagedInputItemIds.push(row.id);
          return;
        }
        await this.stagePayloadUpgrade(row, item, responsesItemEncryptedContent(item));
        return;
      }
    }

    const encryptedContent = responsesItemEncryptedContent(item);
    if (encryptedContent !== null) {
      const row = this.getItemsByEncryptedContentHash(await hashResponsesItemEncryptedContent(encryptedContent))
        .find(candidate => candidate.itemType === item.type);
      if (row !== undefined) {
        this.touchItem(row.id);
        if (row.payload !== null) {
          this.stagedInputItemIds.push(row.id);
          return;
        }
        await this.stagePayloadUpgrade(row, item, encryptedContent);
        return;
      }
    }

    const contentHash = await hashResponsesItemContent(item);
    const existing = this.reusableItemByContentHash(contentHash);
    if (existing) {
      this.touchItem(existing.id);
      this.stagedInputItemIds.push(existing.id);
      return;
    }

    const now = Date.now();
    const row: StoredResponsesItem = {
      id: createStoredResponsesItemId(item.type),
      apiKeyId: this.apiKeyId,
      upstreamId: null,
      upstreamItemId: null,
      itemType: item.type,
      origin: 'input',
      payload: { item: structuredClone(item) },
      contentHash,
      encryptedContentHash: encryptedContent === null ? null : await hashResponsesItemEncryptedContent(encryptedContent),
      createdAt: now,
      refreshedAt: now,
    };
    this.stagedInputItems.set(row.id, row);
    this.stagedInputItemIds.push(row.id);
    this.rememberItem(row);
  }

  private async stagePayloadUpgrade(row: StoredResponsesItem, item: ResponsesInputItem, encryptedContent: string | null): Promise<void> {
    const now = Date.now();
    const upgraded: StoredResponsesItem = {
      ...row,
      payload: { item: structuredClone(item) },
      contentHash: await hashResponsesItemContent(item),
      encryptedContentHash: encryptedContent === null ? row.encryptedContentHash : await hashResponsesItemEncryptedContent(encryptedContent),
      createdAt: now,
      refreshedAt: now,
    };
    this.stagedInputItems.set(upgraded.id, upgraded);
    this.payloadUpgradeIds.add(upgraded.id);
    this.stagedInputItemIds.push(upgraded.id);
    this.rememberItem(upgraded);
  }

  private reusableItemByContentHash(hash: string): StoredResponsesItem | undefined {
    const staged = [...this.stagedInputItems.values(), ...this.stagedOutputItems.values()].find(row => row.contentHash === hash);
    if (staged) return staged;
    return this.loadedItemsByContentHash.get(hash)?.find(row => row.payload !== null);
  }

  private rememberItem(row: StoredResponsesItem): void {
    const cloned = cloneStoredResponsesItem(row);
    this.loadedItemsById.set(cloned.id, cloned);
    if (cloned.contentHash !== null) pushByHash(this.loadedItemsByContentHash, cloned.contentHash, cloned);
    if (cloned.encryptedContentHash !== null) pushByHash(this.loadedItemsByEncryptedContentHash, cloned.encryptedContentHash, cloned);
  }

  private rememberSnapshot(snapshot: StoredResponsesSnapshot): void {
    this.snapshotsById.set(snapshot.id, cloneStoredResponsesSnapshot(snapshot));
  }

  private replayableRowsForSnapshot(itemIds: readonly string[]): StoredResponsesItem[] {
    const rows: StoredResponsesItem[] = [];
    const seen = new Set<string>();
    for (const id of itemIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const row = this.loadedItemsById.get(id) ?? this.stagedInputItems.get(id) ?? this.stagedOutputItems.get(id);
      if (row === undefined || !isReplayableSnapshotRow(row)) {
        throw new Error(`Cannot persist Responses snapshot with non-replayable item id=${id}`);
      }
      rows.push(row);
    }
    return rows;
  }

  private async commitItems(rows: readonly StoredResponsesItem[]): Promise<void> {
    const pending = rows.filter(row => !this.committedItemIds.has(row.id));
    if (pending.length === 0) return;
    const payloadUpgrades = pending.filter(row => this.payloadUpgradeIds.has(row.id));
    const inserts = pending.filter(row => !this.payloadUpgradeIds.has(row.id));
    await Promise.all([
      this.repo.responsesItems.insertMany(inserts),
      this.repo.responsesItems.fillPayloads(payloadUpgrades),
    ]);
    for (const row of pending) this.committedItemIds.add(row.id);
    await this.refreshTouchedItems();
  }

  async refreshTouchedItems(): Promise<void> {
    const ids = [...this.touchedItemIds].filter(id => !this.refreshedItemIds.has(id));
    if (ids.length === 0) return;
    const refreshedAt = Date.now();
    await this.repo.responsesItems.refreshMany(this.apiKeyId, ids, refreshedAt);
    for (const id of ids) this.refreshedItemIds.add(id);
  }
}

export const createHttpStatefulResponsesStore = (apiKeyId: string | null, store: boolean | null | undefined): StatefulResponsesStore =>
  new HttpStatefulResponsesStore(getRepo, apiKeyId, store);

const pushByHash = (target: Map<string, StoredResponsesItem[]>, hash: string, row: StoredResponsesItem): void => {
  const rows = target.get(hash) ?? [];
  if (!rows.some(existing => existing.id === row.id && existing.apiKeyId === row.apiKeyId)) {
    rows.push(cloneStoredResponsesItem(row));
    rows.sort(compareItemsByFreshness);
  }
  target.set(hash, rows);
};

const isReplayableSnapshotRow = (row: StoredResponsesItem): boolean =>
  row.payload !== null || (row.upstreamId !== null && row.upstreamItemId !== null);

const cloneStoredResponsesItem = (item: StoredResponsesItem): StoredResponsesItem => ({
  ...item,
  payload: item.payload === null ? null : structuredClone(item.payload),
});

const cloneStoredResponsesSnapshot = (snapshot: StoredResponsesSnapshot): StoredResponsesSnapshot => ({
  ...snapshot,
  itemIds: [...snapshot.itemIds],
});

const compareItemsByFreshness = (a: StoredResponsesItem, b: StoredResponsesItem): number =>
  b.refreshedAt - a.refreshedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
