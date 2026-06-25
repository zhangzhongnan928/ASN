/**
 * R2 P1-A — signed social events: sequence + EIP-712 domain + explicit undo + deterministic LWW,
 * full-inheritance compatible. (spec v0.3 R2 P1-A.)
 *
 * Asserts the attacker cannot: restore an undone like/follow by replaying the old event; replay an
 * event across chains/registries; or use a pre-transfer signature to authorize a post-transfer event.
 * Also: two indexers folding the same events in different orders converge.
 */
import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { signSocialEvent, SocialGraph, verifySocialEvent, type SocialDomain, type OwnerResolver } from "@asn/indexer";

const OLD_KEY = ("0x" + "11".repeat(32)) as Hex;
const NEW_KEY = ("0x" + "22".repeat(32)) as Hex;
const oldAddr = privateKeyToAccount(OLD_KEY).address;
const newAddr = privateKeyToAccount(NEW_KEY).address;

const REGISTRY = ("0x" + "ab".repeat(20)) as Address;
const domain = (chainId: bigint, registry: Address = REGISTRY): SocialDomain => ({ name: "ASN Social", version: "1", chainId, verifyingContract: registry });

const ACTOR = 1n;
// owner resolver: actor 1 controlled by oldAddr until block 100, by newAddr from block 100.
const ownerOf: OwnerResolver = async (id, atBlock) => (id === ACTOR ? (atBlock < 100n ? oldAddr : newAddr) : ("0x" + "00".repeat(20)) as Address);

describe("R2 P1-A — social event replay / ordering / inheritance", () => {
  it("replaying an old LIKE after UNLIKE cannot restore the like", async () => {
    const g = new SocialGraph(domain(1n), ownerOf);
    const like = await signSocialEvent(OLD_KEY, domain(1n), { type: "like", actor: ACTOR, target: "pub:9:1", seq: 1n, block: 10n });
    const unlike = await signSocialEvent(OLD_KEY, domain(1n), { type: "unlike", actor: ACTOR, target: "pub:9:1", seq: 2n, block: 11n });
    expect(await g.ingest(like)).toBe(true);
    expect(g.likeCount("pub:9:1")).toBe(1);
    expect(await g.ingest(unlike)).toBe(true);
    expect(g.likeCount("pub:9:1")).toBe(0);
    // replay the old LIKE (lower seq) — cannot override the UNLIKE.
    expect(await g.ingest(like)).toBe(true);
    expect(g.likeCount("pub:9:1")).toBe(0);
  });

  it("replaying an old FOLLOW after UNFOLLOW cannot restore the follow", async () => {
    const g = new SocialGraph(domain(1n), ownerOf);
    const follow = await signSocialEvent(OLD_KEY, domain(1n), { type: "follow", actor: ACTOR, target: "agent:7", seq: 1n, block: 10n });
    const unfollow = await signSocialEvent(OLD_KEY, domain(1n), { type: "unfollow", actor: ACTOR, target: "agent:7", seq: 2n, block: 11n });
    await g.ingest(follow);
    await g.ingest(unfollow);
    expect(g.isFollowing(ACTOR, 7n)).toBe(false);
    await g.ingest(follow); // replay old follow
    expect(g.isFollowing(ACTOR, 7n)).toBe(false);
  });

  it("an event signed for chain A / registry A cannot be replayed on chain B / registry B", async () => {
    const ev = await signSocialEvent(OLD_KEY, domain(1n), { type: "follow", actor: ACTOR, target: "agent:7", seq: 1n, block: 10n });
    // different chainId domain
    expect(await verifySocialEvent(ev, domain(2n), ownerOf)).toBe(false);
    // different registry domain
    expect(await verifySocialEvent(ev, domain(1n, ("0x" + "cd".repeat(20)) as Address), ownerOf)).toBe(false);
    // correct domain verifies
    expect(await verifySocialEvent(ev, domain(1n), ownerOf)).toBe(true);
    // a graph on chain B rejects it
    const gB = new SocialGraph(domain(2n), ownerOf);
    await gB.ingest(ev);
    expect(gB.isFollowing(ACTOR, 7n)).toBe(false);
  });

  it("two indexers folding the same events in different orders converge", async () => {
    const evs = [
      await signSocialEvent(OLD_KEY, domain(1n), { type: "follow", actor: ACTOR, target: "agent:7", seq: 1n, block: 10n }),
      await signSocialEvent(OLD_KEY, domain(1n), { type: "like", actor: ACTOR, target: "pub:9:1", seq: 2n, block: 11n }),
      await signSocialEvent(OLD_KEY, domain(1n), { type: "unfollow", actor: ACTOR, target: "agent:7", seq: 3n, block: 12n }),
    ];
    const g1 = new SocialGraph(domain(1n), ownerOf);
    for (const e of evs) await g1.ingest(e);
    const g2 = new SocialGraph(domain(1n), ownerOf);
    for (const e of [evs[2]!, evs[0]!, evs[1]!]) await g2.ingest(e); // reverse-ish order
    // converged: following=false (unfollow seq 3 wins), like count 1
    expect(g1.isFollowing(ACTOR, 7n)).toBe(g2.isFollowing(ACTOR, 7n));
    expect(g1.likeCount("pub:9:1")).toBe(g2.likeCount("pub:9:1"));
    expect(g2.isFollowing(ACTOR, 7n)).toBe(false);
    expect(g2.likeCount("pub:9:1")).toBe(1);
  });

  it("a former owner cannot pin a relation with a huge pre-transfer seq (block-ordered LWW)", async () => {
    const g = new SocialGraph(domain(1n), ownerOf);
    // old owner (block 10 < 100) likes with a HUGE seq, trying to pin it forever.
    const poison = await signSocialEvent(OLD_KEY, domain(1n), { type: "like", actor: ACTOR, target: "pub:9:1", seq: 999_999n, block: 10n });
    expect(await g.ingest(poison)).toBe(true);
    expect(g.likeCount("pub:9:1")).toBe(1);
    // new owner (block 150) unlikes with a SMALL seq — later BLOCK wins regardless of seq.
    const newUnlike = await signSocialEvent(NEW_KEY, domain(1n), { type: "unlike", actor: ACTOR, target: "pub:9:1", seq: 1n, block: 150n });
    expect(await g.ingest(newUnlike)).toBe(true);
    expect(g.likeCount("pub:9:1")).toBe(0); // new owner overrode the poisoned high-seq like
    // replaying the poison cannot restore it (block 10 < 150).
    expect(await g.ingest(poison)).toBe(true);
    expect(g.likeCount("pub:9:1")).toBe(0);
  });

  it("a pre-transfer signature cannot authorize a post-transfer event; history attribution is stable", async () => {
    const g = new SocialGraph(domain(1n), ownerOf);
    // pre-transfer (block 10 < 100): old owner controls actor → valid historical event.
    const histLike = await signSocialEvent(OLD_KEY, domain(1n), { type: "like", actor: ACTOR, target: "pub:9:1", seq: 1n, block: 10n });
    expect(await g.ingest(histLike)).toBe(true);
    expect(g.likeCount("pub:9:1")).toBe(1);

    // OLD owner tries to sign a NEW event dated AFTER the transfer (block 150 >= 100). ownerOf(actor,150)
    // == newAddr != oldAddr → rejected. The old owner cannot keep acting after selling.
    const staleNew = await signSocialEvent(OLD_KEY, domain(1n), { type: "unlike", actor: ACTOR, target: "pub:9:1", seq: 2n, block: 150n });
    expect(await g.ingest(staleNew)).toBe(false);
    expect(g.likeCount("pub:9:1")).toBe(1); // unchanged — old owner could not undo post-transfer

    // The NEW owner CAN act (block 150, higher seq), and legitimately unlikes.
    const newUnlike = await signSocialEvent(NEW_KEY, domain(1n), { type: "unlike", actor: ACTOR, target: "pub:9:1", seq: 2n, block: 150n });
    expect(await g.ingest(newUnlike)).toBe(true);
    expect(g.likeCount("pub:9:1")).toBe(0);

    // replaying the OLD owner's pre-transfer like (seq 1) cannot override the new owner's seq-2 unlike.
    expect(await g.ingest(histLike)).toBe(true);
    expect(g.likeCount("pub:9:1")).toBe(0);
  });
});
