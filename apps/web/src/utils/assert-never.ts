// Exhaustiveness helper for closed-union switches. Type-checks at compile
// time that every branch of the union is handled; throws at runtime if a
// silently-expanded union ever reaches it (e.g. a wire-shape change widening
// the type without updating the consumer).

export const assertNever = (value: never): never => {
  throw new Error(`Unhandled union variant: ${String(value)}`);
};
