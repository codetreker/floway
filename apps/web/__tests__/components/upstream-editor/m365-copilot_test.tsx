import { fireEvent, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { M365CopilotConfig } from '../../../src/components/upstream-editor/m365-copilot';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';
import { settle } from '../../settle';

const upstream = upstreamRecord('up_m365', {
  kind: 'm365-copilot-web',
  config: {
    account: {
      tenantId: '11111111-1111-4111-8111-111111111111',
      objectId: '22222222-2222-4222-8222-222222222222',
      username: 'alice@example.com',
      chatHubHost: 'substrate.office.com',
      chatHubPath: '22222222-2222-4222-8222-222222222222@11111111-1111-4111-8111-111111111111',
    },
    locale: 'en-US',
    timeZone: 'UTC',
    timeZoneOffsetMinutes: 0,
  },
  state: {
    credential: {
      refreshTokenSet: true,
      generation: 1,
      health: 'active',
      stateUpdatedAt: '2026-01-01T00:00:00.000Z',
    },
    accessToken: null,
    toneReceipts: {},
  },
});
if (upstream.kind !== 'm365-copilot-web') throw new Error('Expected M365 fixture');
const record = upstream;

const Harness = () => {
  const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(record) });
  return <FormProvider {...form}>
    <M365CopilotConfig onPatch={vi.fn()} onPersistedRecord={vi.fn()} record={record} />
  </FormProvider>;
};

const m365 = (key: string) => i18n.t(`dashboard.upstreamEditor.m365.${key}`);

afterEach(() => vi.unstubAllGlobals());

describe('M365 Copilot editor actions', () => {
  it('locks every mutation control while an action is in flight', async () => {
    let finishRefresh!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finishRefresh = resolve; })));

    renderInApp(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: m365('reenroll') }));
    const bundle = screen.getByRole('textbox', { name: m365('enrollmentBundle') }) as HTMLTextAreaElement;
    fireEvent.change(bundle, { target: { value: '{}' } });

    fireEvent.click(screen.getByRole('button', { name: m365('refresh') }));
    await settle();

    expect(bundle.disabled).toBe(true);
    expect(screen.getByRole('button', { name: m365('refresh') }).getAttribute('aria-disabled')).toBe('true');
    expect((screen.getByRole('button', { name: m365('probeTones') }) as HTMLButtonElement).disabled).toBe(true);
    for (const button of screen.getAllByRole('button', { name: m365('reenroll') })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }

    finishRefresh(Response.json({ status: 'active', patch: { config: record.config, state: record.state } }));
    await settle();
  });
});
