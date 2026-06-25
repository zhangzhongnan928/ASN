/**
 * AT-3 — revoke + key rotation + new revision ⇒ revoked party CANNOT decrypt the new content (TBA model).
 *
 * Per-epoch CEKs are INDEPENDENT random keys; after revoke the capability gate fails for the new epoch
 * so the revoked party never gets CEK_{e+1}. (adversarial-test-spec AT-3, P0.) See docs/R2-TBA-ENCRYPTION-MODEL.md.
 */
import { describe, it, expect } from "vitest";
import { CapType, utf8, fromUtf8, bytesEqual, resourceId as makeResourceId } from "@asn/shared";
import { decryptRevision, unwrapKey, transportAAD } from "@asn/encryption";
import { makeTBASim, tbaAddr } from "../helpers/tbaSim.js";

const RID = makeResourceId(1n, 1n);
const B = 2n; // revoked grantee
const D = 3n; // stays authorized
const TBA_B = tbaAddr("B");
const TBA_D = tbaAddr("D");

describe("AT-3 revoke + rotate + new revision (TBA-gated)", () => {
  it("the revoked grantee cannot read the rotated revision", async () => {
    const s = makeTBASim();
    s.registerTBA(TBA_B);
    s.registerTBA(TBA_D);
    s.bindGrantee(B, TBA_B);
    s.bindGrantee(D, TBA_D);
    s.setController(TBA_B, "ownerB", 1n);
    s.setController(TBA_D, "ownerD", 1n);

    s.grant(B, RID, 2n);
    s.grant(D, RID, 2n);
    s.km.createResource(RID);
    const cek0 = s.km.cek(RID, 0);
    await s.service.sealFor(RID, 0, cek0, B);
    await s.service.sealFor(RID, 0, cek0, D);
    const rev1 = await s.sealRevision(s.km, RID, utf8("secret revision 1"));
    s.finalize(3n);

    // B reads revision 1 and caches CEK_0.
    const ephB = s.newEphemeral();
    const got0 = await s.service.requestKey({
      resourceId: RID, epoch: 0, granteeAgentId: B, requesterEphemeralPublicKey: ephB.publicKey, proofProvider: s.proofProviderFor("ownerB"),
    });
    const cek0_B = unwrapKey(got0.wrapped, ephB.privateKey, transportAAD({ resourceId: RID, epoch: 0, granteeAgentId: B }, got0.decision.authBlockHash));
    expect(fromUtf8(decryptRevision(cek0_B, RID, 0, rev1.body))).toBe("secret revision 1");

    // ── revoke B, rotate to epoch 1, seal CEK_1 to D only, publish revision 2.
    s.revoke(B, RID, 5n);
    const epoch1 = s.km.rotate(RID);
    expect(epoch1).toBe(1);
    const cek1 = s.km.cek(RID, 1);
    await s.service.sealFor(RID, 1, cek1, D); // NOT B
    const rev2 = await s.sealRevision(s.km, RID, utf8("secret revision 2"));
    s.finalize(6n);

    expect(await s.oracle.hasCapability(CapType.VIEW, B, RID, 6n)).toBe(false);
    expect(await s.service.hasEnvelope(RID, 1, B)).toBe(false);
    const bRead2 = await s.readRevision(
      s.service,
      { resourceId: RID, epoch: 1, granteeAgentId: B, proofProvider: s.proofProviderFor("ownerB"), ephemeral: s.newEphemeral() },
      rev2.body,
    );
    expect(bRead2).toBeNull();
    expect(() => decryptRevision(cek0_B, RID, 1, rev2.body)).toThrow();
    expect(bytesEqual(cek0_B, cek1)).toBe(false);
    // inherent limit (NOT a failure): B's cached CEK_0 still decrypts OLD revision 1.
    expect(fromUtf8(decryptRevision(cek0_B, RID, 0, rev1.body))).toBe("secret revision 1");

    // positive control: D reads revision 2.
    const dRead2 = await s.readRevision(
      s.service,
      { resourceId: RID, epoch: 1, granteeAgentId: D, proofProvider: s.proofProviderFor("ownerD"), ephemeral: s.newEphemeral() },
      rev2.body,
    );
    expect(fromUtf8(dRead2!)).toBe("secret revision 2");
  });

  it("expiry alone (no explicit revoke) closes the gate to a new epoch", async () => {
    const s2 = makeTBASim(() => 2000); // clock past expiry below
    s2.registerTBA(TBA_B);
    s2.bindGrantee(B, TBA_B);
    s2.setController(TBA_B, "ownerB", 1n);
    s2.oracle.grant(CapType.VIEW, B, RID, 2n, 1100); // expires at t=1100
    s2.km.createResource(RID);
    s2.km.rotate(RID);
    await s2.service.sealFor(RID, 1, s2.km.cek(RID, 1), B);
    const r2 = await s2.sealRevision(s2.km, RID, utf8("rev2"));
    s2.finalize(3n);
    const denied = await s2.readRevision(
      s2.service,
      { resourceId: RID, epoch: 1, granteeAgentId: B, proofProvider: s2.proofProviderFor("ownerB"), ephemeral: s2.newEphemeral() },
      r2.body,
    );
    expect(denied).toBeNull();
  });
});
