import type { DumpMetadata, DumpRecordId, StoredDumpRecord } from './types.ts';

// Per-API-key request dump storage contract: metadata in SQL, bytes in
// FileProvider. Concrete impls live in `apps/platform-*`. Records carry
// raw `Uint8Array` bodies — wire encoding is the control plane's concern.

export interface DumpListOptions {
  before?: DumpRecordId;
  limit: number;
}

export interface DumpStore {
  // Write body files BEFORE the metadata row so a partial failure leaves
  // orphan files (sweep-collectable), not orphan rows (broken records).
  put(keyId: string, record: StoredDumpRecord): Promise<void>;

  // Newest-first, paginated by ULID cursor. Retention is enforced by the
  // cron sweep, not here, so the dashboard may briefly show records that
  // have aged past retention until the next sweep window drops them.
  list(keyId: string, opts: DumpListOptions): Promise<DumpMetadata[]>;

  get(keyId: string, recordId: DumpRecordId): Promise<StoredDumpRecord | null>;

  // Drop every record (rows + files) for this key. Idempotent.
  purgeAll(keyId: string): Promise<void>;

  // Drop records older than `retentionSeconds` for this key. Idempotent.
  purgeExpired(keyId: string, retentionSeconds: number): Promise<void>;
}
