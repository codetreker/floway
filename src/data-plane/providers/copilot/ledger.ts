import type { CopilotModelsResponse, CopilotRawModel } from './types.ts';

const LEDGER_TTL_MS = 24 * 60 * 60 * 1000;

export interface CopilotLedgerEntry {
  snapshot: CopilotRawModel;
  lastSeenAt: number;
}

export interface CopilotLedger {
  fetchedAt: number;
  models: Record<string, CopilotLedgerEntry>;
}

export const emptyLedger = (): CopilotLedger => ({ fetchedAt: 0, models: {} });

export const projectLedger = (ledger: CopilotLedger, now: number): CopilotRawModel[] =>
  Object.values(ledger.models)
    .filter(entry => now - entry.lastSeenAt < LEDGER_TTL_MS)
    .map(entry => entry.snapshot);

export const mergeLedger = (
  prev: CopilotLedger,
  response: CopilotModelsResponse,
  now: number,
): CopilotLedger => {
  const models: Record<string, CopilotLedgerEntry> = { ...prev.models };
  for (const raw of response.data) {
    if (!raw.id) continue;
    models[raw.id] = { snapshot: raw, lastSeenAt: now };
  }
  for (const [id, entry] of Object.entries(models)) {
    if (now - entry.lastSeenAt >= LEDGER_TTL_MS) delete models[id];
  }
  return { fetchedAt: now, models };
};
