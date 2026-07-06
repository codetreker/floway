// 26-character Crockford Base32 ULID — 10 chars of millisecond timestamp
// followed by 16 chars of randomness. Lexical order matches creation order
// (within the same millisecond, randomness breaks ties), which lets us use
// the id itself as a stable, monotonically-increasing cursor for record
// pagination without a separate sequence number.
//
// Spec: https://github.com/ulid/spec

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTimestamp = -1;
let lastRandom: number[] = [];

const encodeTime = (now: number): string => {
  let out = '';
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = now % ENCODING_LEN;
    out = ENCODING[mod]! + out;
    now = (now - mod) / ENCODING_LEN;
  }
  return out;
};

const randomBytes = (n: number): number[] => {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b % ENCODING_LEN);
};

const incrementRandom = (chars: number[]): number[] => {
  // Carry-propagating +1 on the random tail. Used when two ULID calls land
  // in the same millisecond — preserves the monotonic-within-ms invariant
  // the cursor contract depends on without a separate counter. Overflow
  // (>32^16 ≈ 10^24 ULIDs in the same ms) is physically unreachable, so we
  // let the loop fall off the end and throw rather than papering over it.
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i]! < ENCODING_LEN - 1) {
      chars[i]!++;
      return chars;
    }
    chars[i] = 0;
  }
  throw new Error('ulid: random-tail overflow within a single millisecond');
};

const encodeChars = (chars: readonly number[]): string => {
  let out = '';
  for (const c of chars) out += ENCODING[c];
  return out;
};

export const ulid = (now: number = Date.now()): string => {
  // Treat any clock rewind (NTP step, container snapshot restore, etc.) as
  // a same-ms collision: keep the previous timestamp and bump randomness.
  // Without this guard a backwards-stepping clock produces ULIDs that sort
  // BEFORE their predecessors, breaking the cursor contract.
  const effective = now > lastTimestamp ? now : lastTimestamp;
  let random: number[];
  if (effective === lastTimestamp) {
    random = incrementRandom([...lastRandom]);
  } else {
    random = randomBytes(RANDOM_LEN);
  }
  lastTimestamp = effective;
  lastRandom = random;
  return encodeTime(effective) + encodeChars(random);
};
