// Promise wrapper around setTimeout that respects an AbortSignal — rejects
// immediately if the signal is already aborted, and clears the timer / rejects
// if the signal aborts mid-wait.
export const sleep = (delayMs: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    return;
  }
  const handle = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, delayMs);
  const onAbort = (): void => {
    clearTimeout(handle);
    reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
});
