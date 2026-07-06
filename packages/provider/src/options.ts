// Indirection for outbound HTTP so per-upstream proxy chains can be
// threaded by reference.
//
// The optional third arg lets callers wrap the inner fetch with a per-call
// latency recorder. Not passing it runs the inner fetch unwrapped.
export type Fetcher = (
  url: string,
  init: RequestInit,
  recordUpstreamLatency?: <T>(promise: Promise<T>) => Promise<T>,
) => Promise<Response>;

// Plain runtime fetch as a Fetcher, for callers that need neither proxy
// nor recorder wrapping.
export const directFetcher: Fetcher = (url, init) => fetch(url, init);

// Per-call options for upstream fetch helpers: a per-upstream Fetcher plus
// optional headers merged on top of the helper's own default headers.
// Bundling the recorder with the fetcher in the options bag keeps helpers
// from re-threading it through every call signature.
export interface UpstreamFetchOptions {
  extraHeaders?: Headers;
  fetcher: Fetcher;
  recordUpstreamLatency?: <T>(promise: Promise<T>) => Promise<T>;
}
