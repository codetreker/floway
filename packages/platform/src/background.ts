// Per-request scheduler for fire-and-forget work. The resolver lives in
// `@floway-dev/gateway` (it depends on Hono's `Context`); this type is just the
// shape the resolver returns.
export type BackgroundScheduler = (promise: Promise<unknown>) => void;
