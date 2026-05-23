// Tri-state override map. Absent key = inherit from the parent layer.
// `true` = force-on at this layer. `false` = force-off at this layer (including
// flags seeded by provider defaults — admins explicitly toggled Off to opt out).
export type FlagOverrides = Record<string, boolean>;

export const resolveEffectiveFlags = (
  providerDefaults: ReadonlySet<string>,
  layers: readonly (FlagOverrides | undefined)[],
): ReadonlySet<string> => {
  const effective = new Set<string>(providerDefaults);
  for (const layer of layers) {
    if (!layer) continue;
    for (const [id, on] of Object.entries(layer)) {
      if (on) effective.add(id);
      else effective.delete(id);
    }
  }
  return effective;
};
