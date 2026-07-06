import type { DumpErrorMeta } from '@floway-dev/gateway/dump-types';

type RowSeverity = 'ok' | 'warn' | 'err';

const rowSeverity = (status: number | null, error: DumpErrorMeta | null): RowSeverity => {
  if (status === null || error !== null) return 'err';
  if (status >= 500) return 'err';
  if (status >= 400) return 'warn';
  return 'ok';
};

export const rowTintClass = (status: number | null, error: DumpErrorMeta | null, selected: boolean): string => {
  if (selected) return 'bg-accent-cyan/10';
  switch (rowSeverity(status, error)) {
  case 'err': return 'bg-accent-rose/[0.04] hover:bg-accent-rose/[0.08]';
  case 'warn': return 'bg-accent-amber/[0.04] hover:bg-accent-amber/[0.08]';
  case 'ok': return 'hover:bg-white/[0.02]';
  }
};

// At-a-glance gateway-answered-OK signal: check on 2xx, cross (severity-
// tinted) otherwise. The exact status code and any error string surface
// elsewhere (list-row trailer, detail-section error caption).
interface StatusIcon {
  readonly iconClass: string;
  readonly colorClass: string;
  readonly tooltip: string;
}

export const statusIcon = (status: number | null, error: DumpErrorMeta | null): StatusIcon => {
  const tooltip = status === null ? 'No response' : `HTTP ${status}`;
  switch (rowSeverity(status, error)) {
  case 'ok': return { iconClass: 'i-lucide-check', colorClass: 'text-accent-emerald', tooltip };
  case 'warn': return { iconClass: 'i-lucide-x', colorClass: 'text-accent-amber', tooltip };
  case 'err': return { iconClass: 'i-lucide-x', colorClass: 'text-accent-rose', tooltip };
  }
};

// Short label for the categorized error kinds — composed from the kind and
// the HTTP status the response carried. The free-form `failed` reason is too
// long to fit the row trailer (which only has room for one or two words);
// the detail panel renders that text separately.
export const errorLabel = (error: DumpErrorMeta | null, status: number | null): string | null => {
  if (!error || error.kind === 'failed') return null;
  // `||` over `??` deliberately: 0 isn't a real HTTP status, so a falsy
  // status (null, undefined, or 0) should fall through to the canary.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  return `${error.kind} error ${status || '???'}`;
};
