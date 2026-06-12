// Random short id with a typed prefix. Strip dashes so the result stays
// URL- and SQL-safe; take a 24-char tail — wider than the random subspace
// strictly needs so collisions stay negligible without bloating the id.

export const shortId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
