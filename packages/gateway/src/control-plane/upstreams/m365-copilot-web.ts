import { logM365ActionFailure } from './m365-error-log.ts';
import { resolveControlPlaneFetcher, resolveControlPlaneWebSocketConnector } from './proxy-resolution.ts';
import { upstreamRecordToJson } from './serialize.ts';
import { upstreamErrorMessage } from './shared.ts';
import { storedCatalogSize } from '../../data-plane/providers/catalog.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { normalizeProxyFallbackList } from '../../repo/proxy-fallback-list.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import { shortId } from '../../shared/short-id.ts';
import type {
  m365CopilotWebEnrollmentBody,
  m365CopilotWebProbeTonesBody,
  m365CopilotWebRefreshBody,
} from '../schemas.ts';
import { nextSortOrder } from '../shared/sort-order.ts';
import { warmModelsCache } from '../shared/warm-models-cache.ts';
import { normalizeModelPrefix, type UpstreamRecord } from '@floway-dev/provider';
import {
  M365_MODELS,
  M365BusyError,
  M365OAuthError,
  M365StateConflictError,
  assertM365CopilotWebUpstreamRecord,
  claimM365EnrollmentLease,
  commitM365ToneReceiptsState,
  completeM365Enrollment,
  ensureM365AccessToken,
  probeAllM365Tones,
  readM365CopilotWebUpstreamState,
  refreshM365Credential,
  releaseM365EnrollmentLease,
  renewM365EnrollmentLease,
  type M365EnrollmentLease,
  type M365CopilotWebUpstreamRecord,
} from '@floway-dev/provider-m365-copilot-web';

const parseJson = (raw: string, label: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new Error(`${label} must be valid JSON`, { cause });
  }
};

const isM365AccountConflict = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('idx_upstreams_m365_account');

const responsePatch = (record: UpstreamRecord) => {
  const serialized = upstreamRecordToJson(record);
  if (serialized.kind !== 'm365-copilot-web') throw new Error('Expected an M365 Copilot web upstream');
  return { config: serialized.config, state: serialized.state };
};

const responseRecord = (record: M365CopilotWebUpstreamRecord) => ({
  ...upstreamRecordToJson(record),
  modelsCache: {
    fetchedAt: record.modelsCache?.fetchedAt ?? null,
    lastError: record.modelsCache?.lastError ?? null,
    modelCount: storedCatalogSize(record),
  },
});

const loadM365Record = async (id: string): Promise<M365CopilotWebUpstreamRecord> => {
  if (id === '') throw new Error('This action requires a persisted upstream');
  const record = await getRepo().upstreams.getById(id);
  if (record === null) throw new Error('Upstream not found');
  assertM365CopilotWebUpstreamRecord(record);
  readM365CopilotWebUpstreamState(record.state);
  return record;
};

const actionFailure = (operation: string, error: unknown): string => {
  logM365ActionFailure(operation, error);
  return `${operation} failed. Inspect the gateway logs for details.`;
};

const enrollmentFailure = (c: CtxWithJson<typeof m365CopilotWebEnrollmentBody>, error: unknown) => {
  if (error instanceof M365BusyError) {
    return c.json({ error: 'Cannot re-enroll while an M365 request is in flight' }, 409);
  }
  if (error instanceof M365StateConflictError) {
    return c.json({ error: 'M365 state changed during re-enrollment. Retry after active requests finish.' }, 409);
  }
  if (error instanceof TypeError) return c.json({ error: error.message }, 400);
  const message = actionFailure('M365 enrollment', error);
  return c.json(
    { error: error instanceof M365OAuthError ? 'Microsoft rejected the enrollment bundle. Generate a new bundle and retry.' : message },
    error instanceof M365OAuthError ? 400 : 502,
  );
};

const releaseEnrollmentLease = async (
  upstreamId: string,
  lease: M365EnrollmentLease,
  primaryError?: unknown,
) => {
  try {
    await releaseM365EnrollmentLease(upstreamId, lease);
    return null;
  } catch (releaseError) {
    const reported = primaryError === undefined
      ? releaseError
      : new AggregateError(
          [primaryError, releaseError],
          `M365 operation failed and its enrollment lease release also failed: ${upstreamErrorMessage(releaseError)}`,
          { cause: primaryError },
        );
    return actionFailure('M365 enrollment lease release', reported);
  }
};

const transportOptions = (record: { id: string; proxy_fallback_list?: unknown }, request: Request) => {
  const override = Array.isArray(record.proxy_fallback_list)
    ? normalizeProxyFallbackList(record.proxy_fallback_list as { id: string; colos?: string[] }[])
    : undefined;
  return { override, upstreamId: record.id || undefined, runtimeLocation: getRuntimeLocation(request) };
};

export const m365CopilotWebEnroll = async (c: CtxWithJson<typeof m365CopilotWebEnrollmentBody>) => {
  const {
    enrollment_bundle: rawEnrollment,
    locale,
    record: draft,
    time_zone: timeZone,
    time_zone_offset_minutes: timeZoneOffsetMinutes,
  } = c.req.valid('json');

  let bundle: unknown;
  try {
    bundle = parseJson(rawEnrollment, 'enrollment_bundle');
  } catch (error) {
    return c.json({ error: upstreamErrorMessage(error) }, 400);
  }

  let modelPrefix;
  try {
    modelPrefix = normalizeModelPrefix(draft.model_prefix);
  } catch (error) {
    return c.json({ error: upstreamErrorMessage(error) }, 400);
  }

  if (draft.id !== '') {
    const loaded = await getRepo().upstreams.getById(draft.id);
    if (loaded === null) return c.json({ error: 'Upstream not found' }, 404);
    if (loaded.kind !== 'm365-copilot-web') return c.json({ error: 'Upstream is not an M365 Copilot web upstream' }, 400);
    assertM365CopilotWebUpstreamRecord(loaded);
    let lease: M365EnrollmentLease;
    try {
      lease = await claimM365EnrollmentLease(loaded.id);
    } catch (error) {
      return enrollmentFailure(c, error);
    }

    try {
      const fetcher = await resolveControlPlaneFetcher(transportOptions(draft, c.req.raw));
      const imported = await completeM365Enrollment({
        bundle,
        fetcher,
        locale,
        timeZone,
        timeZoneOffsetMinutes,
      });
      await renewM365EnrollmentLease(loaded.id, lease);
      const claimed = await loadM365Record(loaded.id);
      const replacement = await getRepo().upstreams.replaceConfigAndStatePreservingMetadata(
        loaded.id,
        'm365-copilot-web',
        {
          config: imported.config,
          state: imported.state,
          expectedState: claimed.state,
          updatedAt: new Date().toISOString(),
          enabled: false,
        },
      );
      if (replacement.status === 'missing') return c.json({ error: 'Upstream not found' }, 404);
      if (replacement.status === 'state-conflict') {
        const conflict = new M365StateConflictError('M365 state changed during re-enrollment');
        const releaseError = await releaseEnrollmentLease(loaded.id, lease, conflict);
        if (releaseError !== null) return c.json({ error: releaseError }, 502);
        return c.json({ error: 'M365 state changed during re-enrollment. Retry after active requests finish.' }, 409);
      }
      assertM365CopilotWebUpstreamRecord(replacement.record);
      return c.json({ record: responseRecord(replacement.record) });
    } catch (error) {
      const releaseError = await releaseEnrollmentLease(loaded.id, lease, error);
      if (releaseError !== null) return c.json({ error: releaseError }, 502);
      if (isM365AccountConflict(error)) return c.json({ error: 'Microsoft account already configured' }, 409);
      return enrollmentFailure(c, error);
    }
  }

  let imported: Awaited<ReturnType<typeof completeM365Enrollment>>;
  try {
    const fetcher = await resolveControlPlaneFetcher(transportOptions(draft, c.req.raw));
    imported = await completeM365Enrollment({
      bundle,
      fetcher,
      locale,
      timeZone,
      timeZoneOffsetMinutes,
    });
  } catch (error) {
    return enrollmentFailure(c, error);
  }

  const existingRows = await getRepo().upstreams.list();
  const now = new Date().toISOString();
  const created: UpstreamRecord = {
    id: shortId('up'),
    kind: 'm365-copilot-web',
    name: draft.name,
    enabled: false,
    sortOrder: nextSortOrder(existingRows),
    createdAt: now,
    updatedAt: now,
    flagOverrides: draft.flag_overrides,
    disabledPublicModelIds: draft.disabled_public_model_ids,
    proxyFallbackList: normalizeProxyFallbackList(draft.proxy_fallback_list),
    modelPrefix,
    hue: draft.hue,
    config: imported.config,
    state: imported.state,
    modelsCache: null,
  };
  assertM365CopilotWebUpstreamRecord(created);
  readM365CopilotWebUpstreamState(created.state);
  try {
    await getRepo().upstreams.save(created);
  } catch (error) {
    if (isM365AccountConflict(error)) return c.json({ error: 'Microsoft account already configured' }, 409);
    throw error;
  }
  return c.json({ record: responseRecord(created) }, 201);
};

export const m365CopilotWebRefresh = async (c: CtxWithJson<typeof m365CopilotWebRefreshBody>) => {
  const { record: editor } = c.req.valid('json');
  try {
    const record = await loadM365Record(editor.id);
    const fetcher = await resolveControlPlaneFetcher(transportOptions(editor, c.req.raw));
    await refreshM365Credential(record.id, fetcher);
    const refreshed = await loadM365Record(record.id);
    return c.json({ status: 'active' as const, patch: responsePatch(refreshed) });
  } catch (error) {
    if (error instanceof M365OAuthError && error.oauthCode === 'invalid_grant' && editor.id !== '') {
      logM365ActionFailure('M365 credential refresh', error);
      const refreshed = await loadM365Record(editor.id);
      return c.json({
        status: 'reauth_required' as const,
        message: 'Microsoft rejected the stored session. Re-enroll this account.',
        patch: responsePatch(refreshed),
      });
    }
    return c.json({ error: actionFailure('M365 credential refresh', error) }, 502);
  }
};

export const m365CopilotWebProbeTones = async (c: CtxWithJson<typeof m365CopilotWebProbeTonesBody>) => {
  const { record: editor } = c.req.valid('json');
  let lease: M365EnrollmentLease | null = null;
  try {
    const persisted = await loadM365Record(editor.id);
    const claimedLease = await claimM365EnrollmentLease(persisted.id);
    lease = claimedLease;
    const record = await loadM365Record(persisted.id);
    const credentialId = readM365CopilotWebUpstreamState(record.state).credential.credentialId;
    const options = transportOptions(editor, c.req.raw);
    const [fetcher, connectWebSocket] = await Promise.all([
      resolveControlPlaneFetcher(options),
      resolveControlPlaneWebSocketConnector(options),
    ]);
    const token = await ensureM365AccessToken(record.id, fetcher);
    const toneReceipts = await probeAllM365Tones({
      config: record.config,
      accessToken: token.token,
      connectWebSocket,
      renewLease: () => renewM365EnrollmentLease(record.id, claimedLease),
      signal: c.req.raw.signal,
    });
    await getRepo().upstreams.saveStateClearingModelsCache(record.id, current => commitM365ToneReceiptsState(
      readM365CopilotWebUpstreamState(current),
      {
        claimToken: claimedLease.claimToken,
        credentialId,
        toneReceipts,
        now: Date.now(),
      },
    ));
    lease = null;
    const released = await loadM365Record(record.id);
    await warmModelsCache(released, c);
    return c.json({ patch: responsePatch(released), total: M365_MODELS.length, available: Object.values(toneReceipts).filter(receipt => receipt.available).length });
  } catch (error) {
    if (lease !== null && editor.id !== '') {
      const releaseError = await releaseEnrollmentLease(editor.id, lease, error);
      if (releaseError !== null) return c.json({ error: releaseError }, 502);
    }
    if (error instanceof M365BusyError) return c.json({ error: 'The M365 account already has an in-flight operation' }, 409);
    if (error instanceof M365StateConflictError) return c.json({ error: 'M365 state changed during the tone probe. Retry after active requests finish.' }, 409);
    return c.json({ error: actionFailure('M365 tone probe', error) }, 502);
  }
};
