/**
 * ASN VIEW-gating crypto primitives (spec v0.3 §5.2).
 *
 * Two layers:
 *   1. Content encryption — body of revision r is sealed with the resource's CEK for epoch(r),
 *      using XChaCha20-Poly1305 (AEAD).
 *   2. Key wrapping (ECIES) — a CEK is delivered to a grantee ONLY as an envelope sealed to the
 *      grantee's X25519 public key (ephemeral-static ECDH + HKDF + XChaCha20-Poly1305).
 *
 * The single most important property for AT-3: **per-epoch CEKs are independent random keys**, NOT a
 * hash chain. Holding CEK_e yields zero information about CEK_{e+1}. See encryption/tbaKeyService.ts.
 */
import { x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { randomBytes } from "@noble/hashes/utils";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 as mhSha256 } from "multiformats/hashes/sha2";
import { concatBytes, keccak256, bytesEqual, type Hex } from "@asn/shared";

export const CEK_BYTES = 32;
const XNONCE_BYTES = 24;
const HKDF_INFO = new TextEncoder().encode("ASN/VIEW/ecies/v1");

export interface X25519KeyPair {
  privateKey: Uint8Array; // 32 bytes
  publicKey: Uint8Array; // 32 bytes
}

/** Generate a fresh, INDEPENDENT random Content Encryption Key. Never derived from another CEK. */
export function generateCEK(): Uint8Array {
  return randomBytes(CEK_BYTES);
}

export function generateX25519KeyPair(): X25519KeyPair {
  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

const ZERO32 = new Uint8Array(32);

/** Reject malformed / obviously-invalid X25519 public keys before use. */
export function assertValidX25519PublicKey(pk: Uint8Array): void {
  if (pk.length !== 32) throw new Error("invalid x25519 public key: bad length");
  if (bytesEqual(pk, ZERO32)) throw new Error("invalid x25519 public key: all-zero point");
}

/** Compute an X25519 shared secret, rejecting the all-zero result produced by low-order/contributory
 *  points (a small-subgroup attack would otherwise yield a predictable key). */
function sharedSecretOrThrow(scalar: Uint8Array, point: Uint8Array): Uint8Array {
  assertValidX25519PublicKey(point);
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(scalar, point);
  } catch {
    throw new Error("invalid x25519 point: shared secret computation failed");
  }
  if (bytesEqual(shared, ZERO32)) throw new Error("invalid x25519 point: all-zero shared secret");
  return shared;
}

// ── content encryption ───────────────────────────────────────────────────────────────────────

export interface SealedBody {
  /** Serialized stored bytes = version(1) || nonce(24) || ciphertext. This is what goes to IPFS. */
  bytes: Uint8Array;
}

export function encryptBody(cek: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): SealedBody {
  const nonce = randomBytes(XNONCE_BYTES);
  const ct = xchacha20poly1305(cek, nonce, aad).encrypt(plaintext);
  return { bytes: concatBytes(new Uint8Array([1]), nonce, ct) };
}

/** Decrypt a stored body with a CEK. Throws on auth failure (wrong/old key, or wrong AAD context) —
 *  this is the AT-3 fail. `aad` must equal the value used at encryption (binds to resourceId+epoch). */
export function decryptBody(cek: Uint8Array, stored: Uint8Array, aad?: Uint8Array): Uint8Array {
  if (stored.length < 1 + XNONCE_BYTES + 16 || stored[0] !== 1) {
    throw new Error("malformed sealed body");
  }
  const nonce = stored.subarray(1, 1 + XNONCE_BYTES);
  const ct = stored.subarray(1 + XNONCE_BYTES);
  return xchacha20poly1305(cek, nonce, aad).decrypt(ct); // throws if AEAD tag/AAD invalid
}

/** AAD that binds a sealed body to its (resourceId, epoch) context. */
export function contentAAD(resourceId: string, epoch: number): Uint8Array {
  return new TextEncoder().encode(`asn/content/${resourceId}/${epoch}`);
}

/** AAD that binds a key envelope to its (resourceId, epoch, granteeAgentId) context. */
export function envelopeAAD(resourceId: string, epoch: number, granteeAgentId: bigint): Uint8Array {
  return new TextEncoder().encode(`asn/envelope/${resourceId}/${epoch}/${granteeAgentId.toString()}`);
}

// ── ECIES key wrapping (envelope) ──────────────────────────────────────────────────────────────

export interface WrappedKey {
  ephemeralPublicKey: Uint8Array; // 32
  nonce: Uint8Array; // 24
  ciphertext: Uint8Array; // sealed CEK
}

export function wrapKey(cek: Uint8Array, recipientPublicKey: Uint8Array, aad?: Uint8Array): WrappedKey {
  const eph = generateX25519KeyPair();
  const shared = sharedSecretOrThrow(eph.privateKey, recipientPublicKey);
  const key = hkdf(sha256, shared, undefined, HKDF_INFO, 32);
  const nonce = randomBytes(XNONCE_BYTES);
  const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(cek);
  return { ephemeralPublicKey: eph.publicKey, nonce, ciphertext };
}

/** Unwrap a CEK envelope with the recipient's X25519 private key. Throws if the envelope was not
 *  sealed to this recipient OR if `aad` (the resourceId/epoch/grantee context) does not match — so a
 *  revoked party cannot unwrap someone else's envelope or replay an envelope in a different context. */
export function unwrapKey(wrapped: WrappedKey, recipientPrivateKey: Uint8Array, aad?: Uint8Array): Uint8Array {
  const shared = sharedSecretOrThrow(recipientPrivateKey, wrapped.ephemeralPublicKey);
  const key = hkdf(sha256, shared, undefined, HKDF_INFO, 32);
  return xchacha20poly1305(key, wrapped.nonce, aad).decrypt(wrapped.ciphertext);
}

// ── content addressing ───────────────────────────────────────────────────────────────────────

/** keccak256 of the stored bytes — matches Publications.bodyHash. */
export function bodyHash(stored: Uint8Array): Hex {
  return keccak256(stored);
}

/** CIDv1 (raw, sha2-256) of the stored bytes. */
export async function computeCID(stored: Uint8Array): Promise<string> {
  const digest = await mhSha256.digest(stored);
  return CID.create(1, raw.code, digest).toString();
}

/** cidDigest anchored on-chain = keccak256(utf8(cidString)). Lets the indexer verify the CID. */
export function cidDigest(cidString: string): Hex {
  return keccak256(new TextEncoder().encode(cidString));
}
