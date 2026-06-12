// expiredLabel is what to render once the delta is <= 0: 'now' disappears
// immediately, 'expiring' reads as a final tick instead of vanishing.

export const formatCountdown = (ms: number, expiredLabel: 'now' | 'expiring' = 'now'): string => {
  if (ms <= 0) return expiredLabel;
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
};
