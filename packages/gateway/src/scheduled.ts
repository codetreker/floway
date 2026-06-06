import { getRepo } from './repo/index.ts';
import { RESPONSES_ITEM_PAYLOAD_TTL_MS, startOfUtcHour, sweepExpiredResponsesItemPayloadFiles } from './repo/responses-payload.ts';

// Read only by this scheduled cleanup (deleteOlderThan). Lookups never filter
// by it — a row stays referenceable until cleanup removes it.
const RESPONSES_ITEM_ROW_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export const runScheduledMaintenance = async (): Promise<void> => {
  const now = startOfUtcHour(Date.now());
  await getRepo().responsesItems.clearPayloadOlderThan(now - RESPONSES_ITEM_PAYLOAD_TTL_MS);
  await sweepExpiredResponsesItemPayloadFiles(now);
  await getRepo().responsesSnapshots.deleteOlderThan(now - RESPONSES_ITEM_ROW_TTL_MS);
  await getRepo().responsesItems.deleteOlderThan(now - RESPONSES_ITEM_ROW_TTL_MS);
};
