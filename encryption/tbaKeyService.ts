/**
 * TBA-gated key service (spec v0.3 R2 — replaces the old X25519 per-grantee envelope model).
 *
 * Trust model (DISCLOSED, MVP): the publisher operates this key service. It custodies the per-epoch
 * CEKs and the decryption keys for the TBA-registered encryption pubkeys. It is NOT gatekeeper-free:
 * the operator could refuse a legitimate reader or leak a CEK. What it cannot do is let an
 * UNAUTHORIZED party in: a CEK is released only when ALL hold —
 *   1. the requester PROVES current control of the grantee's TBA (ERC-1271), and
 *   2. the grantee holds a live VIEW capability, and
 *   3. both are evaluated at a FINALIZED block (P0-A — irreversible release needs irreversible state).
 *
 * Inheritance is automatic and requires no re-seal: an at-rest envelope is sealed once to the
 * grantee's STABLE TBA encryption pubkey; after an NFT transfer the new owner can prove TBA control
 * (ERC-1271 follows ownership) and the service unwraps the SAME envelope for them — zero seller
 * cooperation. There is no "re-seal on transfer" concept anywhere.
 *
 * Per-epoch CEKs remain INDEPENDENT random keys (AT-3): revoke + rotate + new revision ⇒ the revoked
 * party fails the capability gate for the new epoch ⇒ never gets CEK_{e+1}.
 */
import { CapType, bytesToHex, type Hex } from "@asn/shared";
import {
  generateCEK,
  generateX25519KeyPair,
  wrapKey,
  unwrapKey,
  envelopeAAD,
  type WrappedKey,
  type X25519KeyPair,
} from "./crypto.js";
import { controlChallenge, type TBAControlVerifier } from "./tbaControl.js";
import type { CapabilityOracle } from "./oracle.js";
import type { FinalitySource } from "./finality.js";

const slot = (resourceId: Hex, epoch: number) => `${resourceId}:${epoch}`;
const envSlot = (resourceId: Hex, epoch: number, tba: Hex) => `${resourceId}:${epoch}:${tba.toLowerCase()}`;

/** Resolves the canonical ERC-6551 Token Bound Account address for an AgentId. Deterministic (a pure
 *  function of the NFT — independent of owner/block). Binding the request's TBA to the granteeAgentId
 *  via this resolver is what prevents a controller from pairing their TBA with someone else's
 *  capability (the critical R2 binding fix). */
export type TBAResolver = (granteeAgentId: bigint) => Promise<Hex>;

export class KeyDenied extends Error {}

/** Per-resource, per-epoch INDEPENDENT random CEKs (unchanged AT-3 core). */
export class ResourceKeyManager {
  private ceks = new Map<string, Uint8Array>();
  private epochs = new Map<Hex, number>();

  createResource(resourceId: Hex): number {
    if (this.epochs.has(resourceId)) throw new KeyDenied("resource exists");
    this.epochs.set(resourceId, 0);
    this.ceks.set(slot(resourceId, 0), generateCEK());
    return 0;
  }
  currentEpoch(resourceId: Hex): number {
    const e = this.epochs.get(resourceId);
    if (e === undefined) throw new KeyDenied("unknown resource");
    return e;
  }
  rotate(resourceId: Hex): number {
    const next = this.currentEpoch(resourceId) + 1;
    this.epochs.set(resourceId, next);
    this.ceks.set(slot(resourceId, next), generateCEK()); // fresh independent key
    return next;
  }
  cek(resourceId: Hex, epoch: number): Uint8Array {
    const c = this.ceks.get(slot(resourceId, epoch));
    if (!c) throw new KeyDenied(`no CEK ${resourceId}@${epoch}`);
    return c;
  }
}

/**
 * Custodian of the encryption keypairs bound to each TBA. The PUBLIC key is registered on-chain
 * (TBAKeyRegistry); the PRIVATE key is held here (the disclosed custodial element). Rotation lets the
 * owner force a fresh keypair (e.g. suspected service-key compromise) — future envelopes use it.
 */
export class TBAEncKeyStore {
  private keys = new Map<Hex, X25519KeyPair>();

  /** Generate (or rotate) the TBA's enc keypair; returns the public key to register on-chain. */
  register(tba: Hex): Uint8Array {
    const kp = generateX25519KeyPair();
    this.keys.set(tba.toLowerCase() as Hex, kp);
    return kp.publicKey;
  }
  rotate(tba: Hex): Uint8Array {
    return this.register(tba);
  }
  publicKey(tba: Hex): Uint8Array {
    return this.req(tba).publicKey;
  }
  private req(tba: Hex): X25519KeyPair {
    const kp = this.keys.get(tba.toLowerCase() as Hex);
    if (!kp) throw new KeyDenied(`no enc key registered for TBA ${tba}`);
    return kp;
  }
  privateKey(tba: Hex): Uint8Array {
    return this.req(tba).privateKey;
  }
}

export interface KeyDecision {
  authBlockNumber: bigint;
  authBlockHash: Hex;
}

export interface KeyResponse {
  /** CEK re-wrapped (ECIES) to the requester's ephemeral transport key, bound to the auth block. */
  wrapped: WrappedKey;
  decision: KeyDecision;
}

export interface KeyRequest {
  resourceId: Hex;
  epoch: number;
  /** The ONLY grantee identifier the requester supplies. The TBA is derived from this, so a controller
   *  cannot pair their TBA with a different identity's capability. */
  granteeAgentId: bigint;
  requesterEphemeralPublicKey: Uint8Array;
  /** Signs the service-issued control challenge (proves current control of the grantee's TBA). */
  proofProvider: (challenge: Hex) => Promise<Hex>;
}

/** The gating key service. */
export class TBAKeyService {
  /** at-rest envelopes: (resource,epoch,granteeTBA) -> CEK sealed to that TBA's enc pubkey. */
  private envelopes = new Map<string, WrappedKey>();
  readonly decisionLog: Array<{ resourceId: Hex; epoch: number; granteeAgentId: bigint; granteeTBA: Hex } & KeyDecision> = [];

  constructor(
    private readonly control: TBAControlVerifier,
    private readonly oracle: CapabilityOracle,
    private readonly finality: FinalitySource,
    private readonly encKeys: TBAEncKeyStore,
    /** Resolves the canonical TBA for a granteeAgentId — the binding that closes the borrow-capability hole. */
    private readonly tbaOf: TBAResolver,
  ) {}

  /** Publisher seals a CEK at rest to the grantee's canonical TBA encryption pubkey (one-time; no
   *  re-seal). The envelope AAD binds the granteeAgentId. */
  async sealFor(resourceId: Hex, epoch: number, cek: Uint8Array, granteeAgentId: bigint): Promise<void> {
    const tba = await this.tbaOf(granteeAgentId);
    const wrapped = wrapKey(cek, this.encKeys.publicKey(tba), envelopeAAD(resourceId, epoch, granteeAgentId));
    this.envelopes.set(envSlot(resourceId, epoch, tba), wrapped);
  }

  async hasEnvelope(resourceId: Hex, epoch: number, granteeAgentId: bigint): Promise<boolean> {
    return this.envelopes.has(envSlot(resourceId, epoch, await this.tbaOf(granteeAgentId)));
  }

  /**
   * Release the CEK iff (control of the grantee's canonical TBA proven) AND (that grantee's capability
   * is live) AND (finalized state). The TBA is DERIVED from granteeAgentId, so control + capability +
   * envelope are all bound to the same identity. Throws KeyDenied otherwise.
   */
  async requestKey(req: KeyRequest): Promise<KeyResponse> {
    // (P0-A) authorize ONLY against finalized state.
    const finalized = await this.finality.finalized();
    const canonical = await this.finality.blockHashAt(finalized.number);
    if (canonical === null || canonical !== finalized.hash) {
      throw new KeyDenied("finalized block hash mismatch — aborting (possible reorg)");
    }

    // Bind the TBA to the requested grantee identity. Control is proven over THIS TBA only.
    const granteeTBA = await this.tbaOf(req.granteeAgentId);

    const ephHex = bytesToHex(req.requesterEphemeralPublicKey);
    const challenge = controlChallenge(req.resourceId, req.epoch, req.granteeAgentId, granteeTBA, ephHex, finalized.hash);
    const proof = await req.proofProvider(challenge);

    // 1. control of the grantee's OWN TBA at the finalized block.
    if (!(await this.control.verifyControl(granteeTBA, challenge, proof, finalized.number))) {
      throw new KeyDenied("not the TBA controller at the finalized block (ERC-1271 failed)");
    }
    // 2. that SAME grantee's capability at the finalized block (cannot borrow another's).
    if (!(await this.oracle.hasCapability(CapType.VIEW, req.granteeAgentId, req.resourceId, finalized.number))) {
      throw new KeyDenied("no live capability at the finalized block");
    }
    // 3. unwrap the at-rest envelope (AAD bound to granteeAgentId), re-wrap to the requester's key.
    const env = this.envelopes.get(envSlot(req.resourceId, req.epoch, granteeTBA));
    if (!env) throw new KeyDenied("no envelope for this (resource, epoch, grantee)");
    const cek = unwrapKey(env, this.encKeys.privateKey(granteeTBA), envelopeAAD(req.resourceId, req.epoch, req.granteeAgentId));

    const decision: KeyDecision = { authBlockNumber: finalized.number, authBlockHash: finalized.hash };
    const wrapped = wrapKey(cek, req.requesterEphemeralPublicKey, transportAAD(req, finalized.hash));
    this.decisionLog.push({ resourceId: req.resourceId, epoch: req.epoch, granteeAgentId: req.granteeAgentId, granteeTBA, ...decision });
    return { wrapped, decision };
  }
}

/** AAD binding the delivered CEK to (resource, epoch, granteeAgentId, auth block) — reproducible. */
export function transportAAD(req: { resourceId: Hex; epoch: number; granteeAgentId: bigint }, authBlockHash: Hex): Uint8Array {
  return new TextEncoder().encode(`asn/transport/${req.resourceId}/${req.epoch}/${req.granteeAgentId}/${authBlockHash}`);
}
