import { createM365Deadline, withM365Abort } from './deadline.ts';
import { renewM365TurnClaim, type M365ClaimedTurn } from './sessions.ts';

export const M365_HEARTBEAT_INTERVAL_MS = 30_000;
export const M365_HEARTBEAT_IO_TIMEOUT_MS = 10_000;

export interface M365Heartbeat {
  failure: Promise<never>;
  stop(): void;
}

export const startM365Heartbeat = (upstreamId: string, turn: M365ClaimedTurn): M365Heartbeat => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectFailure!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  const schedule = () => {
    timer = setTimeout(() => {
      const deadline = createM365Deadline(undefined, M365_HEARTBEAT_IO_TIMEOUT_MS, () => new Error('M365 heartbeat renewal timed out'));
      void withM365Abort(renewM365TurnClaim(upstreamId, turn), deadline.signal)
        .then(() => { if (!stopped) schedule(); })
        .catch(error => { if (!stopped) rejectFailure(error); })
        .finally(deadline.dispose);
    }, M365_HEARTBEAT_INTERVAL_MS);
  };
  schedule();
  return {
    failure,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
};
