/**
 * R2 P0-A — key release authorized ONLY on finalized state (spec v0.3 R2 P0-A).
 *
 * A delivered CEK is irreversible. A grant or transfer that exists only in an unsafe/orphaned block
 * must NEVER produce a key. "Attack succeeds" iff a key releases on non-finalized state, or the
 * decision is not reproducible from the recorded block ref.
 */
import { describe, it, expect } from "vitest";
import { utf8, type Hex, resourceId as makeResourceId } from "@asn/shared";
import { TBAKeyService, type FinalitySource } from "@asn/encryption";
import { makeTBASim, tbaAddr, blockHash } from "../helpers/tbaSim.js";

const RID = makeResourceId(1n, 1n);
const G = 5n;
const TBA_G = tbaAddr("G");

function setup(now?: () => number) {
  const s = makeTBASim(now);
  s.registerTBA(TBA_G);
  s.bindGrantee(G, TBA_G);
  s.setController(TBA_G, "owner", 1n);
  s.km.createResource(RID);
  return s;
}

describe("R2 P0-A — finalized-only key release", () => {
  it("a grant that exists only in an unsafe block never yields a key until finalized", async () => {
    const s = setup();
    await s.service.sealFor(RID, 0, s.km.cek(RID, 0), G);
    const rev1 = await s.sealRevision(s.km, RID, utf8("secret"));

    s.grant(G, RID, 8n); // grant lands in (future) block 8
    s.finalize(5n);
    s.mineTo(8n); // block 8 at head but not finalized

    const denied = await s.readRevision(
      s.service,
      { resourceId: RID, epoch: 0, granteeAgentId: G, proofProvider: s.proofProviderFor("owner"), ephemeral: s.newEphemeral() },
      rev1.body,
    );
    expect(denied).toBeNull();
    expect(s.service.decisionLog.length).toBe(0);

    // block 8 orphaned + re-mined without the grant → grant never finalizes.
    s.finality.reorgFrom(6n);
    s.oracle.reorgFrom(6n);
    s.mineTo(9n);
    s.finalize(9n);
    const stillDenied = await s.readRevision(
      s.service,
      { resourceId: RID, epoch: 0, granteeAgentId: G, proofProvider: s.proofProviderFor("owner"), ephemeral: s.newEphemeral() },
      rev1.body,
    );
    expect(stillDenied).toBeNull();
    expect(s.service.decisionLog.length).toBe(0);
  });

  it("a transfer that exists only in an unsafe block does not change the accepted controller", async () => {
    const s = setup();
    s.grant(G, RID, 2n);
    await s.service.sealFor(RID, 0, s.km.cek(RID, 0), G);
    const rev1 = await s.sealRevision(s.km, RID, utf8("secret"));
    s.finalize(3n);

    s.setController(TBA_G, "buyer", 8n); // transfer in unsafe block 8
    s.mineTo(8n);
    const buyerDenied = await s.readRevision(
      s.service,
      { resourceId: RID, epoch: 0, granteeAgentId: G, proofProvider: s.proofProviderFor("buyer"), ephemeral: s.newEphemeral() },
      rev1.body,
    );
    expect(buyerDenied).toBeNull();
  });

  it("aborts when the finalized block hash does not match canonical (reorg detection)", async () => {
    const badFinality: FinalitySource = {
      async finalized() {
        return { number: 5n, hash: ("0x" + "aa".repeat(32)) as Hex };
      },
      async blockHashAt(n: bigint) {
        return n === 5n ? (("0x" + "bb".repeat(32)) as Hex) : null;
      },
    };
    const s = setup();
    s.grant(G, RID, 2n);
    await s.service.sealFor(RID, 0, s.km.cek(RID, 0), G);

    const svc = new TBAKeyService(s.control, s.oracle, badFinality, s.encKeys, async (id) => (id === G ? TBA_G : ("0x" + "00".repeat(20)) as Hex));
    await expect(
      svc.requestKey({ resourceId: RID, epoch: 0, granteeAgentId: G, requesterEphemeralPublicKey: s.newEphemeral().publicKey, proofProvider: s.proofProviderFor("owner") }),
    ).rejects.toThrow(/finalized block hash mismatch/);
  });

  it("a successful authorization records a reproducible {authBlockNumber, authBlockHash}", async () => {
    const s = setup();
    s.grant(G, RID, 2n);
    await s.service.sealFor(RID, 0, s.km.cek(RID, 0), G);
    await s.sealRevision(s.km, RID, utf8("secret"));
    s.finalize(3n);

    const res = await s.service.requestKey({
      resourceId: RID, epoch: 0, granteeAgentId: G, requesterEphemeralPublicKey: s.newEphemeral().publicKey, proofProvider: s.proofProviderFor("owner"),
    });
    expect(res.decision.authBlockNumber).toBe(3n);
    expect(res.decision.authBlockHash).toBe(blockHash(3n));
    expect(s.service.decisionLog.at(-1)).toMatchObject({ authBlockNumber: 3n, authBlockHash: blockHash(3n) });
  });
});
