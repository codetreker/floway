import { createStoredResponsesItemId, hashResponsesItemContent, hashResponsesItemEncryptedContent, responsesItemEncryptedContent, responsesItemId } from './format.ts';
import type { StoredResponsesItem } from '../../../../../repo/types.ts';
import type { LlmTargetApi, RequestContext } from '../../../interceptors.ts';
import type { ResponsesSnapshotMode } from '../stateful-store.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
import type {
  ResponsesItemFinalizedHandler,
  ResponsesItemIdMapper,
  ResponsesItemsView,
} from '@floway-dev/translate/via-responses/responses-items';

// Source-stream middleware that mints a gateway-owned stored id for every
// Responses item carrier in the outgoing source stream and persists the
// matching row.
//
// Runs at the source-serve layer after all source interceptors, so items
// dropped or synthesized by interceptors are correctly reflected in
// persistence. The view's `streamMapIdAsResponsesItems` separates two
// concerns: per-frame id rewriting (sync via `idMapper`) and per-item
// persistence (via `onItemFinalized`, fired at each carrier's finalizing
// frame).
//
// Persistence is opportunistic but read-after-write consistent. A failed
// write must never sink an already-billable response, so every insert
// swallows its error (logged); but the row must be visible by the time the
// client could reference the stored id, so the insert is awaited rather than
// fired off:
//
// - Streaming: the row is awaited at the carrier's done frame, just before
//   that frame is yielded onward, so a client that has seen `done` finds the
//   row on its next turn. The stored id is exposed earlier at the added
//   frame; the added->done replay race is accepted. There is no buffer to
//   flush, so `commitForNonStreaming` is undefined.
//
// - Non-streaming: the response is assembled by draining the whole stream
//   into one JSON body; an item-done followed by a stream-level error makes
//   the reassembler throw and the request returns 502 with no body. Persisting
//   per item during that drain would leave rows for items the client never
//   received, so the handler only buffers finalized rows and
//   `commitForNonStreaming` writes the batch — awaited by the orchestrator on
//   the success branch, after the body is known good, so the returned ids are
//   immediately referenceable.
//
// The stored row carries the upstream's original item in `payload.item`, so the
// id there is the upstream's id, not the stored id; `request-plan.ts` rewrites
// it at expansion time based on routing.
export interface StoreResponsesContext {
  readonly targetApi: LlmTargetApi;
  readonly upstream: string;
  readonly store: boolean | null | undefined;
  readonly snapshotMode: ResponsesSnapshotMode;
}

// Flushes the rows buffered during a non-streaming drain. Streaming has no
// buffer to flush — each row is written at its carrier's done frame — so the
// stream carries no committer at all in that mode.
export type ResponsesItemsCommit = () => Promise<void>;

export interface StoredResponsesItemsStream<TFrame> {
  readonly events: AsyncIterable<TFrame>;
  readonly commitForNonStreaming: ResponsesItemsCommit | undefined;
}

export const storeResponsesOutputItems = <TFrame>(
  frames: AsyncIterable<TFrame>,
  view: Pick<ResponsesItemsView<never, TFrame>, 'streamMapIdAsResponsesItems'>,
  context: StoreResponsesContext,
  request: RequestContext,
  wantsStream: boolean,
): StoredResponsesItemsStream<TFrame> => {
  const upstreamToStored = new Map<string, string>();
  const statefulResponsesStore = request.statefulResponsesStore;

  // An upstream id that happens to parse as a gateway stored id is not
  // special-cased: `request-plan.ts` rewrites our stored ids away before the
  // upstream call, so any stored-shaped id echoed back is foreign (another
  // gateway, or a checksum coincidence) and gets its own fresh id like any
  // other.
  const idMapper: ResponsesItemIdMapper = (upstreamId, itemType) => {
    let storedId = upstreamToStored.get(upstreamId);
    if (storedId === undefined) {
      storedId = createStoredResponsesItemId(itemType);
      upstreamToStored.set(upstreamId, storedId);
    }
    return storedId;
  };

  const commitStoredItems = async (): Promise<void> => {
    try {
      await statefulResponsesStore.commitOutputItems();
    } catch (error) {
      console.error('Failed to persist stored Responses items:', error);
    }
  };
  const commitSnapshot = async (responseId: string, mode: 'append' | 'replace'): Promise<void> => {
    try {
      await statefulResponsesStore.commitSnapshot(responseId, mode);
    } catch (error) {
      console.error('Failed to persist stored Responses snapshot:', error);
    }
  };

  const onItemFinalized: ResponsesItemFinalizedHandler = async (originalItem, newId) => {
    const row = await buildRow(newId, originalItem, context, request);
    statefulResponsesStore.stageOutputItem(row);
    if (wantsStream) await commitStoredItems();
  };

  // Streaming writes each row at its done frame, so there is nothing to flush;
  // only a non-streaming drain buffers rows for a single commit at the end.
  let terminalResponseId: string | null = null;
  const commitForNonStreaming = wantsStream
    ? undefined
    : async (): Promise<void> => {
      await commitStoredItems();
      if (context.snapshotMode !== 'none' && terminalResponseId !== null) await commitSnapshot(terminalResponseId, context.snapshotMode);
    };

  const events = commitSnapshotFromTerminal(
    view.streamMapIdAsResponsesItems(frames, idMapper, onItemFinalized),
    context,
    wantsStream,
    id => { terminalResponseId = id; },
    commitSnapshot,
  );

  return { events, commitForNonStreaming };
};

const buildRow = async (
  newId: string,
  originalItem: ResponsesInputItem,
  context: StoreResponsesContext,
  request: RequestContext,
): Promise<StoredResponsesItem> => {
  const upstreamId = responsesItemId(originalItem);
  if (upstreamId === null) {
    throw new Error(`Cannot persist Responses item without an upstream id (newId=${newId}, type=${originalItem.type})`);
  }
  // A native Responses upstream owns its items — except those a source
  // interceptor synthesized this request, whose gateway-minted ids the
  // upstream never issued. Those persist with no upstream identity so they
  // stay non_affinity.
  const statefulResponsesStore = request.statefulResponsesStore;
  const upstreamOwned = context.targetApi === 'responses' && !statefulResponsesStore.isSyntheticItem(upstreamId);
  const encryptedContent = responsesItemEncryptedContent(originalItem);
  // Source interceptors register the per-item server-only payload under the
  // wire id transformItems sees; the same id is `upstreamId` here. Attaching
  // it lets a later turn restore the real success/failure state even when the
  // client stripped fields from the echoed wire item.
  const privatePayload = statefulResponsesStore.getPrivatePayload(upstreamId);
  const persistedPayload = privatePayload !== undefined ? { item: originalItem, private: privatePayload } : { item: originalItem };
  const now = Date.now();
  return {
    id: newId,
    apiKeyId: request.apiKeyId ?? null,
    upstreamId: upstreamOwned ? context.upstream : null,
    upstreamItemId: upstreamOwned ? upstreamId : null,
    itemType: originalItem.type,
    origin: upstreamOwned ? 'upstream' : 'synthetic',
    payload: context.store === false ? null : persistedPayload,
    contentHash: await hashResponsesItemContent(originalItem),
    encryptedContentHash: encryptedContent === null ? null : await hashResponsesItemEncryptedContent(encryptedContent),
    createdAt: now,
    refreshedAt: now,
  };
};

const commitSnapshotFromTerminal = async function* <TFrame>(
  frames: AsyncIterable<TFrame>,
  context: StoreResponsesContext,
  wantsStream: boolean,
  rememberTerminalResponseId: (id: string) => void,
  commitSnapshot: (id: string, mode: 'append' | 'replace') => Promise<void>,
): AsyncGenerator<TFrame> {
  for await (const frame of frames) {
    const responseId = terminalResponseId(frame);
    if (responseId !== null) {
      rememberTerminalResponseId(responseId);
      if (wantsStream && context.snapshotMode !== 'none') await commitSnapshot(responseId, context.snapshotMode);
    }
    yield frame;
  }
};

const terminalResponseId = (frame: unknown): string | null => {
  if (!frame || typeof frame !== 'object' || (frame as { type?: unknown }).type !== 'event') return null;
  const event = (frame as { event?: unknown }).event;
  if (!event || typeof event !== 'object') return null;
  const eventType = (event as { type?: unknown }).type;
  if (eventType !== 'response.completed' && eventType !== 'response.incomplete' && eventType !== 'response.failed') return null;
  const response = (event as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return null;
  const id = (response as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
};
