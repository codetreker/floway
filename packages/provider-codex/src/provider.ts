import { getCodexAccessToken } from './access-token-cache.ts';
import { callCodexResponsesCompact } from './compaction.ts';
import { assertCodexUpstreamRecord, type CodexUpstreamConfig } from './config.ts';
import { callCodexResponses, type CodexCallEffects } from './fetch.ts';
import { codexResponsesChain } from './interceptors/responses/index.ts';
import type { ResponsesBoundaryCtx } from './interceptors/responses/types.ts';
import { codexRawToUpstreamModel, fetchCodexCatalog, type CodexRawModel } from './models.ts';
import { pricingForCodexModelKey } from './pricing.ts';
import { assertCodexUpstreamState, type CodexUpstreamState } from './state.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { getProviderRepo, inProcessMemo, readModelsStore, writeModelsStore, type ModelProvider, type ModelProviderInstance, type ProviderCompactionResult, type ProviderStreamResult, type UpstreamModel, type UpstreamRecord } from '@floway-dev/provider';

// L1 (in-process) memo lifetime. Kept short so an operator-triggered model
// list change propagates within minutes even before the L2 ledger ages out.
const MODELS_MEMO_TTL_MS = 2 * 60 * 1000;
// L2 (KV) ledger freshness threshold. The ledger entry has no KV TTL —
// `writeModelsStore` writes without one — so it persists indefinitely. This
// constant is the staleness window for the soft fallback when the live
// /codex/models fetch fails.
const MODELS_LEDGER_FRESH_MS = 24 * 60 * 60 * 1000;

interface CodexModelsLedger {
  fetchedAt: number;
  models: CodexRawModel[];
}

export const createCodexProvider = async (record: UpstreamRecord): Promise<ModelProviderInstance> => {
  assertCodexUpstreamRecord(record);
  assertCodexUpstreamState(record.state);
  const config: CodexUpstreamConfig = record.config;
  // v1 of the codex provider always operates on the first account in the
  // pool. The schema carries an array so a future fan-out can pick a
  // different active account per call without a wire migration.
  const accountIdentity = config.accounts[0];

  // Re-read upstream state on every request rather than capturing the record's
  // state at construction. Refresh-token rotation, terminal-state transitions,
  // and operator re-imports must all be visible to the next in-flight call.
  // Throw rather than guess when the active credential is missing — a row that
  // has lost its credential by id has been hand-edited, and silently using the
  // wrong refresh_token would be worse than failing loudly.
  const readActiveAccount = async () => {
    const fresh = await getProviderRepo().upstreams.getById(record.id);
    if (!fresh) throw new Error(`Codex upstream ${record.id} disappeared mid-request`);
    assertCodexUpstreamState(fresh.state);
    const state = fresh.state;
    const account = state.accounts.find(a => a.chatgptAccountId === accountIdentity.chatgptAccountId);
    if (!account) {
      throw new Error(`Codex upstream ${record.id} state has no credential for account ${accountIdentity.chatgptAccountId}`);
    }
    return { state, account };
  };

  const replaceActiveAccount = (state: CodexUpstreamState, next: CodexUpstreamState['accounts'][number]): CodexUpstreamState => ({
    accounts: state.accounts.map(a => (a.chatgptAccountId === next.chatgptAccountId ? next : a)),
  });

  const persistRefreshTokenRotation = async (newRefreshToken: string): Promise<void> => {
    const { state, account } = await readActiveAccount();
    const next = replaceActiveAccount(state, { ...account, refresh_token: newRefreshToken, state_updated_at: new Date().toISOString() });
    // CAS write keyed on the just-read state. A losing CAS means a concurrent
    // operator re-import (or another isolate's rotation) already advanced the
    // row; their write supersedes ours and no retry is needed.
    await getProviderRepo().upstreams.saveState(record.id, next, { expectedState: state });
  };

  const persistTerminalState = async (newState: 'session_terminated' | 'refresh_failed', message: string): Promise<void> => {
    const { state, account } = await readActiveAccount();
    const next = replaceActiveAccount(state, { ...account, state: newState, state_message: message, state_updated_at: new Date().toISOString() });
    await getProviderRepo().upstreams.saveState(record.id, next, { expectedState: state });
  };

  const effects: CodexCallEffects = { persistRefreshTokenRotation, persistTerminalState };

  const provider: ModelProvider = {
    getProvidedModels: () =>
      inProcessMemo(record.id, MODELS_MEMO_TTL_MS, async () => {
        const cached = await readModelsStore<CodexModelsLedger>(record.id);
        const ledgerFresh = cached !== null && Date.now() - cached.fetchedAt < MODELS_LEDGER_FRESH_MS;
        const fallback = (): UpstreamModel[] => (ledgerFresh ? cached!.models.map(codexRawToUpstreamModel) : []);
        try {
          // Defer the catalog fetch when no access token has been minted yet
          // (cold-imported upstream). The first data-plane call will refresh
          // the OAuth token; the next getProvidedModels then populates the
          // ledger. Until then, return the last known ledger (or empty).
          const access = await getCodexAccessToken(getProviderRepo().cache, record.id);
          if (!access) return fallback();

          const raw = await fetchCodexCatalog({ accessToken: access.access_token, accountId: accountIdentity.chatgptAccountId });
          // Surface every model the upstream returns, including ones whose
          // ChatGPT-side `visibility` is `hide` (e.g. codex-auto-review). The
          // operator's gateway is its own surface — they can dispatch to those
          // models even though the ChatGPT UI hides them — and the dashboard
          // toggles them per-upstream when needed.
          await writeModelsStore<CodexModelsLedger>(record.id, { fetchedAt: Date.now(), models: raw });
          return raw.map(codexRawToUpstreamModel);
        } catch {
          return fallback();
        }
      }),

    // Codex itself is a flat-fee subscription, but the dashboard reports
    // notional cost per request as if the operator were paying OpenAI's
    // public API rates. The table lives in ./pricing.ts.
    getPricingForModelKey: pricingForCodexModelKey,

    callResponses: async (model, body, signal, headers) => {
      const ctx: ResponsesBoundaryCtx = {
        payload: { ...body, model: model.id },
        headers: { ...(headers ?? {}) },
        model,
      };
      return await runInterceptors<ResponsesBoundaryCtx, object, ProviderStreamResult<ResponsesStreamEvent>>(
        ctx, {}, codexResponsesChain<ProviderStreamResult<ResponsesStreamEvent>>(), async () => {
          const { account } = await readActiveAccount();
          const { model: _ignored, ...wireBody } = ctx.payload;
          return await callCodexResponses({
            upstreamId: record.id,
            account,
            model,
            body: wireBody,
            headers: ctx.headers,
            signal,
            cache: getProviderRepo().cache,
            effects,
          });
        },
      );
    },

    callResponsesCompact: async (model, body, signal, headers) => {
      const ctx: ResponsesBoundaryCtx = {
        payload: { ...body, model: model.id },
        headers: { ...(headers ?? {}) },
        model,
      };
      return await runInterceptors<ResponsesBoundaryCtx, object, ProviderCompactionResult>(
        ctx, {}, codexResponsesChain<ProviderCompactionResult>(), async () => {
          const { account } = await readActiveAccount();
          const { model: _ignored, ...wireBody } = ctx.payload;
          return await callCodexResponsesCompact({
            upstreamId: record.id,
            account,
            model,
            body: wireBody,
            headers: ctx.headers,
            signal,
            cache: getProviderRepo().cache,
            effects,
          });
        },
      );
    },

    // Codex serves only /responses; getProvidedModels advertises that single
    // endpoint, so the data plane translates Messages / ChatCompletions /
    // Gemini through `responsesAttempt` and never calls the methods below.
    callMessages: () => Promise.reject(new Error('Codex provider does not implement callMessages')),
    callChatCompletions: () => Promise.reject(new Error('Codex provider does not implement callChatCompletions')),
    callMessagesCountTokens: () => Promise.reject(new Error('Codex provider does not implement callMessagesCountTokens')),
    callEmbeddings: () => Promise.reject(new Error('Codex provider does not implement callEmbeddings')),
    callImagesGenerations: () => Promise.reject(new Error('Codex provider does not implement callImagesGenerations')),
    callImagesEdits: () => Promise.reject(new Error('Codex provider does not implement callImagesEdits')),
  };

  return {
    upstream: record.id,
    providerKind: 'codex',
    name: record.name,
    disabledPublicModelIds: record.disabledPublicModelIds,
    provider,
    supportsResponsesItemReference: false,
  };
};
