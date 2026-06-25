/**
 * AT-1 — accessing gated content WITHOUT a capability MUST fail (TBA model).
 *
 * The ciphertext is public; what must fail is obtaining the CEK. Even a party that controls its OWN
 * TBA but holds no VIEW capability cannot get the key. (adversarial-test-spec AT-1, P0.)
 */
import { describe, it, expect } from "vitest";
import { CapType, utf8, fromUtf8, resourceId as makeResourceId } from "@asn/shared";
import { wrapKey, unwrapKey, envelopeAAD, generateCEK, generateX25519KeyPair } from "@asn/encryption";
import { makeTBASim, tbaAddr } from "../helpers/tbaSim.js";

const RID = makeResourceId(7n, 1n);
const B = 8n; // legit grantee
const C = 9n; // attacker: controls its own TBA but has NO capability
const TBA_B = tbaAddr("B");
const TBA_C = tbaAddr("C");

describe("AT-1 no capability => no access (TBA-gated)", () => {
  it("C, controlling its own TBA but lacking a capability, cannot obtain the CEK", async () => {
    const s = makeTBASim();
    s.registerTBA(TBA_B);
    s.registerTBA(TBA_C);
    s.bindGrantee(B, TBA_B);
    s.bindGrantee(C, TBA_C);
    s.setController(TBA_B, "ownerB", 1n);
    s.setController(TBA_C, "ownerC", 1n);

    // A grants only B. seal CEK_0 to both grantees that COULD be authorized (here only B is granted).
    s.grant(B, RID, 2n);
    s.km.createResource(RID);
    await s.service.sealFor(RID, 0, s.km.cek(RID, 0), B);
    await s.service.sealFor(RID, 0, s.km.cek(RID, 0), C); // even if an envelope existed for C...
    const rev1 = await s.sealRevision(s.km, RID, utf8("private payload"));
    s.finalize(3n);

    // B (granted, controls TBA_B) reads fine.
    const bRead = await s.readRevision(
      s.service,
      { resourceId: RID, epoch: 0, granteeAgentId: B, proofProvider: s.proofProviderFor("ownerB"), ephemeral: s.newEphemeral() },
      rev1.body,
    );
    expect(fromUtf8(bRead!)).toBe("private payload");

    // C controls TBA_C and even has an envelope, but has NO capability => denied (null).
    expect(await s.oracle.hasCapability(CapType.VIEW, C, RID, 3n)).toBe(false);
    const cRead = await s.readRevision(
      s.service,
      { resourceId: RID, epoch: 0, granteeAgentId: C, proofProvider: s.proofProviderFor("ownerC"), ephemeral: s.newEphemeral() },
      rev1.body,
    );
    expect(cRead).toBeNull();
  });

  it("ECIES rejects invalid points / all-zero shared secret", () => {
    const cek = generateCEK();
    const recip = generateX25519KeyPair();
    const w = wrapKey(cek, recip.publicKey, envelopeAAD(RID, 0, 0n));
    expect(unwrapKey(w, recip.privateKey, envelopeAAD(RID, 0, 0n))).toEqual(cek);

    expect(() => wrapKey(cek, new Uint8Array(32), envelopeAAD(RID, 0, 0n))).toThrow(/all-zero|invalid x25519/);
    expect(() => wrapKey(cek, new Uint8Array(31), envelopeAAD(RID, 0, 0n))).toThrow(/length|invalid x25519/);
    const lowOrder = new Uint8Array(32);
    expect(() => wrapKey(cek, lowOrder, envelopeAAD(RID, 0, 0n))).toThrow();
  });
});
