// Reshape an already-aborted signal into a throwable Error. A structured
// Error reason rethrows as-is so its stack/cause survive; a primitive or
// absent reason becomes a DOMException('AbortError').
export const signalAbortReason = (signal: AbortSignal): Error => {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(String(reason ?? 'aborted'), 'AbortError');
};
