/**
 * High-level gated-publication flow (spec v0.3 R2). Content sealing is unchanged (per-epoch CEK +
 * AEAD bound to resource/epoch). Key delivery now goes through the TBA-gated key service: the reader
 * proves control of their grantee TBA, the service releases the CEK (re-wrapped to an ephemeral key),
 * and the reader decrypts. No grantee-held identity key, no re-seal.
 */
import { bytesToHex, type Hex } from "@asn/shared";
import { encryptBody, decryptBody, bodyHash, cidDigest, computeCID, contentAAD, unwrapKey, type X25519KeyPair } from "./crypto.js";
import { ResourceKeyManager, TBAKeyService, transportAAD, type KeyRequest } from "./tbaKeyService.js";

export interface Commitment {
  cid: string;
  cidDigest: Hex;
  bodyHash: Hex;
  keyEpoch: number;
  body: Uint8Array;
}

/** Encrypt the current revision of a gated resource with its current-epoch CEK. */
export async function sealRevision(km: ResourceKeyManager, resourceId: Hex, plaintext: Uint8Array): Promise<Commitment> {
  const epoch = km.currentEpoch(resourceId);
  const sealed = encryptBody(km.cek(resourceId, epoch), plaintext, contentAAD(resourceId, epoch));
  const cid = await computeCID(sealed.bytes);
  return { cid, cidDigest: cidDigest(cid), bodyHash: bodyHash(sealed.bytes), keyEpoch: epoch, body: sealed.bytes };
}

/** Decrypt a stored body given the CEK (obtained from the key service). */
export function decryptRevision(cek: Uint8Array, resourceId: Hex, epoch: number, storedBody: Uint8Array): Uint8Array {
  return decryptBody(cek, storedBody, contentAAD(resourceId, epoch));
}

/**
 * Full reader flow: request the epoch key from the TBA key service (proving TBA control), unwrap the
 * transport envelope with the ephemeral key, then decrypt the body. Returns null if the service
 * denies (not controller / no capability / not finalized); throws only on a genuine crypto failure.
 */
export async function readRevision(
  service: TBAKeyService,
  req: Omit<KeyRequest, "requesterEphemeralPublicKey"> & { ephemeral: X25519KeyPair },
  storedBody: Uint8Array,
): Promise<Uint8Array | null> {
  try {
    const res = await service.requestKey({
      resourceId: req.resourceId,
      epoch: req.epoch,
      granteeAgentId: req.granteeAgentId,
      requesterEphemeralPublicKey: req.ephemeral.publicKey,
      proofProvider: req.proofProvider,
    });
    const cek = unwrapKey(res.wrapped, req.ephemeral.privateKey, transportAAD(req, res.decision.authBlockHash));
    return decryptRevision(cek, req.resourceId, req.epoch, storedBody);
  } catch (e) {
    // KeyDenied -> null (authorization failure is not a crypto error)
    if ((e as Error).name === "KeyDenied" || (e as Error).constructor?.name === "KeyDenied") return null;
    if (/KeyDenied|denied|no envelope|no live capability|not the TBA controller|finalized block hash/.test((e as Error).message)) {
      return null;
    }
    throw e;
  }
}

export { bytesToHex };
