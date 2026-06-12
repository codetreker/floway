export type DashboardRange = 'today' | '7d' | '30d';

export interface DashboardBuckets {
  keys: string[];
  labels: string[];
}

export interface DashboardRangeQuery {
  start: string;
  end: string;
  bucket: 'hour' | '4h' | 'day';
}

// Color allocation algorithm: entities are sorted by stable id (user.id ASC
// for users; key.createdAt ASC for keys), and the chart color slot is the
// entity's index in that sorted list (mod palette length). This palette order
// is the one-time tuning that makes prod's user.id-sorted users land on the
// colors they had under the original by-key chart — so renaming an account
// or adding a new one no longer reshuffles the dashboard.
export const DASHBOARD_CHART_PALETTE = [
  '#00e676',
  '#00e5ff',
  '#ff5252',
  '#ffd740',
  '#7c4dff',
  '#64ffda',
  '#ff6e40',
  '#40c4ff',
  '#eeff41',
  '#ea80fc',
];

export const chartColor = (slot: number): string =>
  DASHBOARD_CHART_PALETTE[slot % DASHBOARD_CHART_PALETTE.length]!;

export const chartFont = {
  sans: "'DM Sans', sans-serif",
  mono: "'JetBrains Mono', monospace",
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

export const localHourKey = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}`;

export const localDateKey = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const local4hBucketStart = (date: Date): Date => {
  const aligned = new Date(date);
  aligned.setMinutes(0, 0, 0);
  aligned.setHours(aligned.getHours() - (aligned.getHours() % 4));
  return aligned;
};

export const local4hBucketKey = (date: Date): string => localHourKey(local4hBucketStart(date));

export const parseUtcHour = (hour: string): Date => new Date(`${hour}:00:00Z`);

const shortMonthDay = (date: Date): string => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

const toUtcHourParam = (date: Date): string => date.toISOString().slice(0, 13);

const build4hBuckets = (count: number, nowMs: number): DashboardBuckets => {
  const keys: string[] = [];
  const labels: string[] = [];
  const start = local4hBucketStart(new Date(nowMs));
  let previousDateKey: string | null = null;
  for (let i = count - 1; i >= 0; i--) {
    const date = new Date(start.getTime() - i * 4 * 3_600_000);
    const dateKey = localDateKey(date);
    const hour = date.getHours();
    const endHour = (hour + 4) % 24;
    const prefix = dateKey !== previousDateKey ? `${shortMonthDay(date)} ` : '';
    keys.push(localHourKey(date));
    labels.push(`${prefix}${pad2(hour)}:00 - ${pad2(endHour)}:00`);
    previousDateKey = dateKey;
  }
  return { keys, labels };
};

// Pure functions of (range, nowMs). The "now" is taken explicitly so callers
// can derive a buckets snapshot reactively from a `loadedAt` ref — without
// that, a `new Date()` inside the function would be an invisible non-reactive
// read and the chart axis would never shift past the page-open moment.
export const dashboardBuckets = (range: DashboardRange, nowMs: number): DashboardBuckets => {
  if (range === 'today') {
    const current = new Date(nowMs);
    current.setMinutes(0, 0, 0);
    const keys: string[] = [];
    const labels: string[] = [];
    for (let i = 23; i >= 0; i--) {
      const date = new Date(current.getTime() - i * 3_600_000);
      const hour = date.getHours();
      keys.push(localHourKey(date));
      labels.push(`${pad2(hour)}:00 - ${pad2((hour + 1) % 24)}:00`);
    }
    return { keys, labels };
  }
  if (range === '7d') return build4hBuckets(42, nowMs);

  const keys: string[] = [];
  const labels: string[] = [];
  for (let i = 29; i >= 0; i--) {
    const date = new Date(nowMs);
    date.setDate(date.getDate() - i);
    date.setHours(0, 0, 0, 0);
    keys.push(localDateKey(date));
    labels.push(shortMonthDay(date));
  }
  return { keys, labels };
};

export const dashboardRangeQuery = (range: DashboardRange, nowMs: number): DashboardRangeQuery => {
  const now = new Date(nowMs);
  const start = new Date(now);
  if (range === 'today') {
    start.setTime(now.getTime() - 23 * 3_600_000);
    start.setMinutes(0, 0, 0);
  } else if (range === '7d') {
    start.setTime(local4hBucketStart(now).getTime() - 41 * 4 * 3_600_000);
  } else {
    start.setDate(start.getDate() - 29);
    start.setHours(0, 0, 0, 0);
  }
  return {
    start: toUtcHourParam(start),
    end: toUtcHourParam(new Date(now.getTime() + 3_600_000)),
    bucket: range === 'today' ? 'hour' : range === '7d' ? '4h' : 'day',
  };
};

export const bucketKeyForUtcHour = (range: DashboardRange, hour: string): string => {
  const date = parseUtcHour(hour);
  if (range === 'today') return localHourKey(date);
  if (range === '7d') return local4hBucketKey(date);
  return localDateKey(date);
};

export const chartXAxisTick = (bucketKeys: readonly string[], labels: readonly string[], compact4h: boolean) =>
  (_value: unknown, index: number): string => {
    const label = labels[index] ?? '';
    if (!compact4h) return label;
    const hour = Number(String(bucketKeys[index] ?? '').slice(11, 13));
    return Number.isFinite(hour) && hour % 8 === 0 ? label : '';
  };
