// Sentinel for "no proxy — connect directly"; the only legal non-id entry in
// proxy_fallback_list.
export const DIRECT_PROXY_ID = 'direct';

// Entries are bare proxy ids or the literal 'direct' marker; entries are not
// validated against the proxies table.
//
// We treat the list as a SET in semantics, even though it's stored as an
// ordered array — a duplicate proxy entry has no meaning beyond "try once",
// so silently dropping repeats keeps the wire shape and the dial-time shape
// in agreement.
export const normalizeProxyFallbackList = (ids: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
};
