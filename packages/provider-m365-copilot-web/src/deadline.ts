export interface M365Deadline {
  signal: AbortSignal;
  dispose(): void;
}

export const createM365Deadline = (
  parent: AbortSignal | undefined,
  timeoutMs: number,
  timeoutError: () => unknown,
): M365Deadline => {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) forwardAbort();
  else parent?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutError()), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', forwardAbort);
    },
  };
};

export const withM365Abort = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  signal.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
};
