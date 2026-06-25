/**
 * Off-chain signed social events (spec v0.3 §4.1, R2 P1-A): follow/like/repost/reply/block and their
 * explicit undo events (unfollow/unlike/unblock). NOT on-chain — the indexer folds them into the
 * social graph + ranking signals. Hardened per R2 P1-A:
 *
 *  - EIP-712 domain separation (chainId + identityRegistry as verifyingContract) ⇒ an event signed for
 *    one chain/registry cannot be replayed on another.
 *  - Per-actor monotonic SEQUENCE + deterministic last-write-wins ⇒ replaying an old LIKE after an
 *    UNLIKE cannot restore the like; two indexers folding the same events in ANY order converge.
 *  - Explicit undo events (unlike/unfollow/unblock) rather than implicit toggles.
 *  - Each event is verified against the controller of the actor AT THE EVENT'S BLOCK (full-inheritance
 *    compatible): a pre-transfer signature stays valid as history but cannot authorize a post-transfer
 *    event (the new owner must sign new, higher-seq events; the old owner no longer controls the actor).
 */
import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type SocialType = "follow" | "unfollow" | "like" | "unlike" | "block" | "unblock" | "repost" | "reply";

/** EIP-712 domain — binds events to a chain + identity registry. */
export interface SocialDomain {
  name: string; // "ASN Social"
  version: string; // "1"
  chainId: bigint;
  verifyingContract: Address; // the AgentID/identity registry address
}

export interface SocialEventValue {
  type: SocialType;
  actor: bigint; // agentId
  target: string; // "agent:<id>" | "pub:<a>:<p>"
  seq: bigint; // per-actor monotonic sequence
  block: bigint; // creation block (for controller-at-signing verification)
}

export interface SignedSocialEvent extends SocialEventValue {
  signer: Address;
  sig: Hex;
}

/** Block-aware owner resolver: who controls `agentId` at `atBlock`. */
export type OwnerResolver = (agentId: bigint, atBlock: bigint) => Promise<Address>;

const TYPES = {
  SocialEvent: [
    { name: "type", type: "string" },
    { name: "actor", type: "uint256" },
    { name: "target", type: "string" },
    { name: "seq", type: "uint256" },
    { name: "block", type: "uint256" },
  ],
} as const;

function typedData(domain: SocialDomain, v: SocialEventValue) {
  return {
    domain: { name: domain.name, version: domain.version, chainId: domain.chainId, verifyingContract: domain.verifyingContract },
    types: TYPES,
    primaryType: "SocialEvent" as const,
    message: { type: v.type, actor: v.actor, target: v.target, seq: v.seq, block: v.block },
  };
}

export async function signSocialEvent(privateKey: Hex, domain: SocialDomain, v: SocialEventValue): Promise<SignedSocialEvent> {
  const account = privateKeyToAccount(privateKey);
  const sig = await account.signTypedData(typedData(domain, v));
  return { ...v, signer: account.address, sig };
}

/** Verify EIP-712 signature (binds to this exact domain) AND that the signer controlled the actor at
 *  the event's block. Returns false on any mismatch. */
export async function verifySocialEvent(e: SignedSocialEvent, domain: SocialDomain, ownerOf: OwnerResolver): Promise<boolean> {
  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({ ...typedData(domain, e), signature: e.sig });
  } catch {
    return false;
  }
  if (recovered.toLowerCase() !== e.signer.toLowerCase()) return false;
  const controller = await ownerOf(e.actor, e.block);
  return controller.toLowerCase() === e.signer.toLowerCase();
}

const family = (t: SocialType): "follow" | "like" | "block" | "other" =>
  t === "follow" || t === "unfollow" ? "follow" : t === "like" || t === "unlike" ? "like" : t === "block" || t === "unblock" ? "block" : "other";
const isPositive = (t: SocialType): boolean => t === "follow" || t === "like" || t === "block";

/** Folded social graph with deterministic last-write-wins ordered by (block, seq, sig).
 *
 * Ordering by BLOCK first (not seq alone) is essential for full-inheritance: a former owner cannot
 * pin a relation with a huge pre-transfer seq, because any later-block event from the new owner
 * supersedes it regardless of seq. Within a block, seq tie-breaks; sig is the final deterministic
 * tiebreaker so independent indexers converge. */
export class SocialGraph {
  /** key -> winning event {block, seq, sig, positive}. */
  private state = new Map<string, { block: bigint; seq: bigint; sig: Hex; positive: boolean }>();

  constructor(
    private readonly domain: SocialDomain,
    private readonly ownerOf: OwnerResolver,
  ) {}

  /** Returns true iff event `a` should supersede `b` under the (block, seq, sig) total order. */
  private static wins(a: { block: bigint; seq: bigint; sig: Hex }, b: { block: bigint; seq: bigint; sig: Hex }): boolean {
    if (a.block !== b.block) return a.block > b.block;
    if (a.seq !== b.seq) return a.seq > b.seq;
    return a.sig.toLowerCase() > b.sig.toLowerCase();
  }

  /** Ingest a verified event; apply LWW. Returns false if invalid (rejected). Idempotent + order-free. */
  async ingest(e: SignedSocialEvent): Promise<boolean> {
    if (!(await verifySocialEvent(e, this.domain, this.ownerOf))) return false;
    const fam = family(e.type);
    if (fam === "other") return true; // repost/reply: signal only, no state toggle in MVP
    const key = `${e.actor}|${fam}|${e.target}`;
    const cur = this.state.get(key);
    const incoming = { block: e.block, seq: e.seq, sig: e.sig };
    if (cur && !SocialGraph.wins(incoming, cur)) return true; // cannot override a later/equal event
    this.state.set(key, { ...incoming, positive: isPositive(e.type) });
    return true;
  }

  private positive(actor: string, fam: string, target: string): boolean {
    return this.state.get(`${actor}|${fam}|${target}`)?.positive ?? false;
  }

  isFollowing(actor: bigint, target: bigint): boolean {
    return this.positive(actor.toString(), "follow", `agent:${target}`);
  }
  isBlocked(actor: bigint, target: bigint): boolean {
    return this.positive(actor.toString(), "block", `agent:${target}`);
  }
  likeCount(target: string): number {
    let n = 0;
    for (const [key, v] of this.state) {
      const [, fam, ...rest] = key.split("|");
      if (fam === "like" && rest.join("|") === target && v.positive) n++;
    }
    return n;
  }
  followerCount(agentId: bigint): number {
    let n = 0;
    const t = `agent:${agentId}`;
    for (const [key, v] of this.state) {
      const [, fam, ...rest] = key.split("|");
      if (fam === "follow" && rest.join("|") === t && v.positive) n++;
    }
    return n;
  }

  filterForViewer<T extends { agentId: bigint }>(viewer: bigint, items: T[]): T[] {
    return items.filter((i) => !this.isBlocked(viewer, i.agentId));
  }
}
