/**
 * R2 core gate — ERC-6551 TBA decryption inheritance (spec v0.3 R2 "TBA 解密 key 实现").
 *
 * After an NFT transfer the NEW owner controls the same TBA and decrypts PRE-SALE history with zero
 * seller cooperation; non-controllers are rejected; the old owner loses access. "Attack succeeds" iff
 * a non-controller decrypts, or inheritance requires seller cooperation.
 */
import { describe, it, expect } from "vitest";
import { utf8, fromUtf8, resourceId as makeResourceId } from "@asn/shared";
import { makeTBASim, tbaAddr } from "../helpers/tbaSim.js";

const RID = makeResourceId(1n, 1n);
const G = 5n; // grantee agentId (the identity being sold)
const TBA_G = tbaAddr("G");

describe("R2 — TBA decryption inheritance", () => {
  it("new owner decrypts pre-sale history with zero seller cooperation; non-controllers rejected", async () => {
    const s = makeTBASim();
    s.registerTBA(TBA_G);
    s.bindGrantee(G, TBA_G);
    s.setController(TBA_G, "seller", 1n);

    s.grant(G, RID, 2n);
    s.km.createResource(RID);
    await s.service.sealFor(RID, 0, s.km.cek(RID, 0), G);
    const rev1 = await s.sealRevision(s.km, RID, utf8("A's pre-sale private content"));
    s.finalize(3n);

    const read = (proofOwner: string) =>
      s.readRevision(
        s.service,
        { resourceId: RID, epoch: 0, granteeAgentId: G, proofProvider: s.proofProviderFor(proofOwner), ephemeral: s.newEphemeral() },
        rev1.body,
      );

    // Seller can read.
    expect(fromUtf8((await read("seller"))!)).toBe("A's pre-sale private content");

    // ── SALE: control transfers to a buyer at block 10. The seller does NOTHING further.
    s.setController(TBA_G, "buyer", 10n);

    // Before finalize: buyer cannot yet prove control.
    expect(await read("buyer")).toBeNull();

    // After finalize: buyer controls the TBA → reads the SAME pre-sale envelope (no seller help).
    s.finalize(11n);
    expect(fromUtf8((await read("buyer"))!)).toBe("A's pre-sale private content");
    // Old owner (seller) can no longer prove control.
    expect(await read("seller")).toBeNull();
    // Random non-controller rejected.
    expect(await read("not-the-owner")).toBeNull();
  });

  it("control is bound to the grantee's own TBA: a proof for a different owner does not unlock", async () => {
    const s = makeTBASim();
    s.registerTBA(TBA_G);
    s.bindGrantee(G, TBA_G);
    s.setController(TBA_G, "ownerG", 1n);
    s.grant(G, RID, 2n);
    s.km.createResource(RID);
    await s.service.sealFor(RID, 0, s.km.cek(RID, 0), G);
    const rev1 = await s.sealRevision(s.km, RID, utf8("g only"));
    s.finalize(3n);

    // a proof from a different owner cannot unlock G's content.
    const cross = await s.readRevision(
      s.service,
      { resourceId: RID, epoch: 0, granteeAgentId: G, proofProvider: s.proofProviderFor("someone-else"), ephemeral: s.newEphemeral() },
      rev1.body,
    );
    expect(cross).toBeNull();
  });
});
