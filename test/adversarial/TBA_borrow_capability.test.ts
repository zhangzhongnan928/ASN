/**
 * R2 regression (internal review CRITICAL) — a revoked controller CANNOT "borrow" a third party's
 * live capability.
 *
 * The bug (fixed): granteeAgentId (capability) and granteeTBA (control/envelope) were independent
 * caller-supplied fields. A revoked B controlling TBA_B could request with granteeAgentId=D (still
 * authorized) + TBA_B (controlled, envelope present) and get the CEK. The fix derives the TBA
 * canonically from granteeAgentId, so the three gates are bound to ONE identity.
 *
 * "Attack succeeds" (test FAILS) iff the revoked party reads by borrowing another's capability.
 */
import { describe, it, expect } from "vitest";
import { utf8, fromUtf8, resourceId as makeResourceId } from "@asn/shared";
import { makeTBASim, tbaAddr } from "../helpers/tbaSim.js";

const RID = makeResourceId(1n, 1n);
const B = 2n; // revoked attacker; controls TBA_B
const D = 3n; // still-authorized third party
const TBA_B = tbaAddr("B");
const TBA_D = tbaAddr("D");

describe("R2 regression — borrow-a-capability is blocked", () => {
  it("revoked B cannot read by pairing its TBA control with D's live capability", async () => {
    const s = makeTBASim();
    s.registerTBA(TBA_B);
    s.registerTBA(TBA_D);
    s.bindGrantee(B, TBA_B);
    s.bindGrantee(D, TBA_D);
    s.setController(TBA_B, "ownerB", 1n);
    s.setController(TBA_D, "ownerD", 1n);

    // Both B and D granted; CEK_0 sealed to both TBAs; publish revision 1.
    s.grant(B, RID, 2n);
    s.grant(D, RID, 2n);
    s.km.createResource(RID);
    await s.service.sealFor(RID, 0, s.km.cek(RID, 0), B);
    await s.service.sealFor(RID, 0, s.km.cek(RID, 0), D);
    const rev1 = await s.sealRevision(s.km, RID, utf8("epoch-0 secret"));
    s.finalize(3n);

    // B is revoked for the SAME epoch (no rotation). B's honest read is denied.
    s.revoke(B, RID, 4n);
    s.finalize(5n);
    const honest = await s.readRevision(
      s.service,
      { resourceId: RID, epoch: 0, granteeAgentId: B, proofProvider: s.proofProviderFor("ownerB"), ephemeral: s.newEphemeral() },
      rev1.body,
    );
    expect(honest).toBeNull();

    // ATTACK 1: B (controls TBA_B) requests as granteeAgentId=D (D still authorized). The service
    // derives D's canonical TBA (TBA_D), which B does NOT control → control fails → denied.
    const borrow = await s.readRevision(
      s.service,
      { resourceId: RID, epoch: 0, granteeAgentId: D, proofProvider: s.proofProviderFor("ownerB"), ephemeral: s.newEphemeral() },
      rev1.body,
    );
    expect(borrow).toBeNull();

    // ATTACK 2: B requests as itself with its real control — capability is revoked → denied.
    const selfRevoked = await s.readRevision(
      s.service,
      { resourceId: RID, epoch: 0, granteeAgentId: B, proofProvider: s.proofProviderFor("ownerB"), ephemeral: s.newEphemeral() },
      rev1.body,
    );
    expect(selfRevoked).toBeNull();

    // Nothing was released to the attacker.
    expect(s.service.decisionLog.length).toBe(0);

    // Positive control: the legitimate D (controls TBA_D, capability live) still reads.
    const dRead = await s.readRevision(
      s.service,
      { resourceId: RID, epoch: 0, granteeAgentId: D, proofProvider: s.proofProviderFor("ownerD"), ephemeral: s.newEphemeral() },
      rev1.body,
    );
    expect(fromUtf8(dRead!)).toBe("epoch-0 secret");
  });
});
