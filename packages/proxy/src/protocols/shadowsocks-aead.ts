// AEAD primitives shared between the AEAD-2018 and SIP022 Shadowsocks
// dialers. Both protocols frame each direction as independent AEAD streams
// keyed by a per-direction subkey, with a 12-byte little-endian counter
// nonce and a runtime choice of ChaCha20-Poly1305 or AES-GCM. The nonce
// encoder, the `Aead` interface, and the cipher factory are byte-identical
// across the two specs; only the cipher-id literal each dialer recognises
// differs, so we let the caller pre-classify it.

import { gcm } from '@noble/ciphers/aes.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';

const NONCE_LEN = 12;

export interface Aead {
  encrypt(nonce: Uint8Array, plaintext: Uint8Array): Uint8Array;
  decrypt(nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array;
}

/**
 * 12-byte little-endian counter nonce as both Shadowsocks AEAD specs
 * prescribe.
 */
export const leNonce = (counter: bigint): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(NONCE_LEN);
  let c = counter;
  for (let i = 0; i < NONCE_LEN; i++) {
    out[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  return out;
};

/**
 * Each encrypt/decrypt instantiates a fresh cipher state — `@noble/ciphers`
 * exposes a one-shot API only.
 */
export const makeAead = (kind: 'chacha' | 'gcm', key: Uint8Array): Aead => {
  if (kind === 'chacha') {
    return {
      encrypt: (nonce, pt) => chacha20poly1305(key, nonce).encrypt(pt),
      decrypt: (nonce, ct) => chacha20poly1305(key, nonce).decrypt(ct),
    };
  }
  return {
    encrypt: (nonce, pt) => gcm(key, nonce).encrypt(pt),
    decrypt: (nonce, ct) => gcm(key, nonce).decrypt(ct),
  };
};
