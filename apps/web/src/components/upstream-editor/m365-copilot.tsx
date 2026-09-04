import { ArrowClockwiseRegular, PlugConnectedRegular, SearchRegular } from '@fluentui/react-icons';
import { useState } from 'react';
import { useFormContext, useWatch } from 'react-hook-form';

import type { UpstreamEditorValues } from './data';
import { api, callApi } from '../../api/client';
import type { UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { StatusBadge } from '../ui/status-badge';
import { ProviderIcon } from '../upstreams/provider-badge';

const { Button, Field, Spinner, Text, Textarea } = fluentComponents;

type M365Record = Extract<UpstreamRecord, { kind: 'm365-copilot-web' }>;
type ActionName = 'enroll' | 'refresh' | 'probe';

export function M365CopilotConfig({
  onPatch,
  onPersistedRecord,
  record,
}: {
  onPatch: (patch: { config?: unknown; state?: unknown }, persisted?: boolean) => void;
  onPersistedRecord: (record: UpstreamRecord) => void;
  record: M365Record;
}) {
  const { t } = useTranslation();
  const { getValues } = useFormContext<UpstreamEditorValues>();
  const values = useWatch<UpstreamEditorValues>() as UpstreamEditorValues;
  const config = values.config as M365Record['config'];
  const state = values.state as M365Record['state'];
  const hasAccount = config.account !== null && state.credential !== null;
  const [bundle, setBundle] = useState('');
  const [showEnrollment, setShowEnrollment] = useState(!hasAccount);
  const [busy, setBusy] = useState<ActionName | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mutating = busy !== null;

  const actionRecord = () => {
    const current = getValues();
    return {
      id: record.id,
      kind: 'm365-copilot-web' as const,
      proxy_fallback_list: current.proxyFallbackList,
    };
  };

  const enrollmentRecord = () => {
    const current = getValues();
    return {
      ...actionRecord(),
      name: current.name.trim(),
      flag_overrides: current.flagOverrides,
      disabled_public_model_ids: current.disabledPublicModelIds,
      model_prefix: current.modelPrefix,
      hue: current.hue,
    };
  };
  const enroll = async () => {
    try {
      JSON.parse(bundle);
    } catch {
      setError(t('dashboard.upstreamEditor.m365.validation.json'));
      return;
    }
    setBusy('enroll');
    setError(null);
    const result = await callApi(() => api.api.upstreams['m365-copilot-web'].auth.enroll.$post({
      json: {
        record: enrollmentRecord(),
        enrollment_bundle: bundle,
        locale: config.locale,
        time_zone: config.timeZone,
        time_zone_offset_minutes: config.timeZoneOffsetMinutes,
      },
    }));
    setBusy(null);
    if (result.error) { setError(result.error.message); return; }
    onPersistedRecord(result.data.record);
    setBundle('');
    setShowEnrollment(false);
  };

  const refresh = async () => {
    setBusy('refresh');
    setError(null);
    const result = await callApi(() => api.api.upstreams['m365-copilot-web'].auth.refresh.$post({ json: { record: actionRecord() } }));
    setBusy(null);
    if (result.error) { setError(result.error.message); return; }
    onPatch(result.data.patch, true);
    if (result.data.status === 'reauth_required') setError(result.data.message);
  };

  const probe = async () => {
    setBusy('probe');
    setError(null);
    const result = await callApi(() => api.api.upstreams['m365-copilot-web'].tones.probe.$post({ json: { record: actionRecord() } }));
    setBusy(null);
    if (result.error) { setError(result.error.message); return; }
    onPatch(result.data.patch, true);
  };

  const probes = Object.values(state.toneReceipts);
  const availableTones = probes.filter(probe => probe.available).length;

  return <div className="grid gap-4">
    <OutcomeMessageBar intent="warning" title={t('dashboard.upstreamEditor.m365.experimentalTitle')}>
      {t('dashboard.upstreamEditor.m365.experimentalDescription')}
    </OutcomeMessageBar>

    {hasAccount && config.account !== null && state.credential !== null && <div className="grid gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <ProviderIcon kind={record.kind} className="h-8 w-8" />
        <div className="grid gap-0.5 min-w-0">
          <Text block weight="semibold" truncate wrap={false}>{config.account.username}</Text>
          <Text block size={200} className="text-fui-fg2" truncate wrap={false}>
            {t('dashboard.upstreamEditor.m365.tenant', { id: config.account.tenantId })}
          </Text>
        </div>
        <StatusBadge tone={state.credential.health === 'active' ? 'success' : 'danger'}>
          {t(`dashboard.upstreamEditor.m365.credentialHealth.${state.credential.health}`)}
        </StatusBadge>
      </div>
      <Text size={200} className="text-fui-fg2">
        {probes.length === 0
          ? t('dashboard.upstreamEditor.m365.tonesNeverProbed')
          : t('dashboard.upstreamEditor.m365.tonesAvailable', { available: availableTones, total: probes.length })}
      </Text>
      <div className="flex flex-wrap gap-2">
        <Button disabled={mutating} disabledFocusable={busy === 'refresh'} icon={busy === 'refresh' ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />} onClick={() => void refresh()}>
          {t('dashboard.upstreamEditor.m365.refresh')}
        </Button>
        <Button disabled={mutating} disabledFocusable={busy === 'probe'} icon={busy === 'probe' ? <Spinner size="tiny" /> : <SearchRegular />} onClick={() => void probe()}>
          {t('dashboard.upstreamEditor.m365.probeTones')}
        </Button>
        <Button disabled={mutating} onClick={() => setShowEnrollment(value => !value)}>{t('dashboard.upstreamEditor.m365.reenroll')}</Button>
      </div>
    </div>}

    {showEnrollment && <div className="grid gap-3">
      <Field label={t('dashboard.upstreamEditor.m365.enrollmentBundle')} hint={t('dashboard.upstreamEditor.m365.enrollmentBundleHint')}>
        <Textarea
          className="font-mono"
          disabled={mutating}
          onChange={(_, data) => setBundle(data.value)}
          placeholder={t('dashboard.upstreamEditor.m365.enrollmentBundlePlaceholder')}
          rows={8}
          value={bundle}
        />
      </Field>
      <Button
        appearance="primary"
        disabled={mutating || bundle.trim() === ''}
        disabledFocusable={busy === 'enroll'}
        icon={busy === 'enroll' ? <Spinner size="tiny" /> : <PlugConnectedRegular />}
        onClick={() => void enroll()}
      >
        {hasAccount ? t('dashboard.upstreamEditor.m365.reenroll') : t('dashboard.upstreamEditor.m365.enroll')}
      </Button>
    </div>}

    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
  </div>;
}
