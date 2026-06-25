> ⚠️ **SUPERSEDED (R2):** the *gating mechanism* described here (X25519 per-grantee envelopes) has been
> replaced by the **ERC-6551 TBA** model — see **docs/R2-TBA-ENCRYPTION-MODEL.md**. The **per-epoch CEK
> independence** property (the heart of AT-3) is unchanged and still correct. Read this for the AT-3
> key-independence reasoning; read the R2 doc for how keys are now gated and inherited.

# AT-3 Encryption Model — Manual Review Handoff (round 1)

> The build directive flags AT-3 ("revoke + key rotation + new revision ⇒ revoked party cannot
> decrypt the new content") as the part most easily written wrong. This document lays out the
> implementation logic **for human review before delivery**. Do not approve AT-3 on the automated
> test result alone — read this and confirm the reasoning.

Code: `encryption/crypto.ts`, `encryption/keyService.ts`, `encryption/oracle.ts`,
`encryption/publication.ts`. Test: `test/adversarial/AT3_revoke_rotate.test.ts`.
On-chain capability semantics it relies on: `contracts/CapabilityToken.sol`.

---

## 1. What AT-3 actually requires

After A revokes B, rotates the key (epoch e → e+1), and publishes a new revision encrypted under the
new epoch:

- B **must not** be able to obtain the epoch-(e+1) key.
- B **must not** be able to decrypt revision 2.
- Expiry must behave like revoke: once a capability expires, B cannot obtain a *new* epoch key even
  without an explicit `revoke`.
- B keeping the **old** plaintext it already decrypted is acceptable and unavoidable (encryption is
  one-way). The test asserts this is *noted*, not that it is prevented.

The attack "succeeds" (and the loop must NOT finish) if a revoked/expired B can decrypt the
post-rotation revision.

## 2. The three design decisions that make it correct

### 2.1 Per-epoch CEKs are INDEPENDENT random keys (not a hash chain)

`ResourceKeyManager.rotate()` generates `CEK_{e+1} = generateCEK()` — fresh 32 random bytes
(`crypto.ts: generateCEK`). It is **not** `H(CEK_e)`, not `KDF(CEK_e, …)`, not any function of prior
keys. Consequence: possession of `CEK_e` yields **zero** information about `CEK_{e+1}`. If we had used
a forward hash chain, anyone with an old key could compute all future keys and AT-3 would be
unwinnable. This is the single most important line in the model.

> Test assertion: `bytesEqual(cek0_B, cek1) === false`, and B's retained `CEK_0` throws when used to
> decrypt revision 2 (AEAD authentication failure).

### 2.2 Keys are delivered only as per-grantee ENVELOPES, minted only for current holders

A grantee never receives a raw CEK. They receive an **envelope**: the CEK sealed to the grantee's
X25519 public key via ECIES (ephemeral-static ECDH → HKDF-SHA256 → XChaCha20-Poly1305,
`crypto.ts: wrapKey/unwrapKey`).

`ResourceKeyManager.issueEnvelope()` refuses to create an envelope unless
`oracle.hasCapability(VIEW, granteeAgentId, resourceId)` is **currently true**. On rotation,
`rotateAndReissue()` only re-issues to grantees that still pass that check. So after A revokes B:

- A's tooling does not create a `(resourceId, e+1, B)` envelope (B is not in the authorized set), and
- even if it tried, `issueEnvelope` would throw because the oracle now returns false.

> Test assertion: `gw.exists(RID, 1, B) === false` — no epoch-(e+1) envelope for B exists at all.
> This is the **cryptographic** guarantee: there is simply nothing for B to unwrap.

### 2.3 The gateway re-checks capability at FETCH time (defense in depth)

`KeyGateway.fetchEnvelope()` also calls the oracle and returns `null` if the grantee is not currently
authorized. So even if (hypothetically) an envelope existed or a reference leaked, a
revoked/expired B cannot pull it. Two independent gates — issuance and serving — both keyed to the
live capability state.

> Test assertion: `obtainEpochKey(gw, oracle, RID, 1, B, …) === null` after revoke.

## 3. The capability state itself (on-chain) is the source of truth

The oracle mirrors `CapabilityToken.hasCapability` (`contracts/CapabilityToken.sol`):

- `revoke` deletes the grant ⇒ `hasCapability` returns false immediately.
- `expiry`: `hasCapability` returns `block.timestamp < expiry`; once past expiry it returns false
  **without** an explicit revoke. The `InMemoryCapabilityOracle` reproduces this with an injectable
  clock, and the on-chain version is exercised by the forge capability-lifecycle test and the
  integration test (`OnchainCapabilityOracle`).

So "revoke" and "expiry" both collapse to the same gate result (false), and both therefore close key
issuance and key serving.

## 4. Step-by-step trace of the AT-3 test

1. A `createResource(RID)` → epoch 0, random `CEK_0`.
2. A grants B and D on-chain; oracle reflects it. A `issueEnvelope` for B and D at epoch 0.
3. A seals revision 1 with `CEK_0`. **Sanity:** B decrypts revision 1. B caches `CEK_0`.
4. **Action:** A `revoke(B)` (oracle now false for B). A `rotateAndReissue([B, D])`:
   - `rotate()` → epoch 1, fresh independent `CEK_1`.
   - re-issue loop: D passes the oracle and gets a `(RID, 1, D)` envelope; B fails the oracle and is
     skipped — no `(RID, 1, B)` envelope is ever created.
5. A seals revision 2 with `CEK_1` (keyEpoch = 1).
6. **Assertions (attacker = B):**
   - `hasCapability(B)` is false.
   - `obtainEpochKey(RID, 1, B)` → null (gateway denies).
   - `gw.exists(RID, 1, B)` → false (no envelope minted).
   - `openRevision(rev2, B)` → null (no key).
   - `decryptBody(cek0_B, rev2)` throws (old key cannot decrypt new revision; keys independent).
   - `bytesEqual(cek0_B, cek1)` is false.
   - **Inherent-limit note (not a failure):** `decryptBody(cek0_B, rev1)` still returns "revision 1".
   - **Positive control:** D (still authorized) decrypts revision 2.
7. **Expiry boundary test:** grant B with an expiry; advance the clock past it; A rotates without ever
   calling revoke; `issueEnvelope(B, epoch 1)` rejects and `obtainEpochKey(B, epoch 1)` is null.

## 5. Threats explicitly considered

- **Key-chain derivation:** defeated by §2.1 (independent random CEKs).
- **Re-using an old envelope at the new epoch:** an old envelope wraps `CEK_e`, which cannot decrypt
  content sealed under `CEK_{e+1}` (different independent key + AEAD).
- **Requesting a future epoch before revoke:** the future epoch does not exist yet
  (`issueEnvelope` rejects `epoch > currentEpoch`); by the time epoch e+1 exists, B is already
  revoked.
- **Fetching another grantee's envelope:** ECIES seals to the grantee's public key; B lacks D's
  private key, so D's envelope is useless to B even if read.
- **Bypassing the gateway:** the cryptographic layer (no envelope minted) holds even with no gateway;
  the gateway check is an extra layer, not the only one.

## 6. Known limitations (by design, disclosed in risk-disclosure-draft.md)

- Plaintext B already decrypted is unrecoverable. Rotation protects only *future* revisions.
- The honest issuer must actually rotate + re-seal to apply a revoke to new content. Until A
  publishes a new revision under the new epoch, B can still read the last revision it had a key for.
  This matches the spec: revoke blocks acquiring *new* keys; it does not retroactively re-encrypt
  already-published revisions under the old epoch.
- This MVP runs the key manager + gateway as owner-side tooling + a registry. A production deployment
  would distribute the gateway (e.g., threshold/MPC like Lit) so no single server can serve keys
  against the on-chain capability state. The on-chain `hasCapability` remains the authority either way.

---

**Reviewer checklist:**
- [ ] Confirm `rotate()` uses a fresh independent random CEK (no derivation from prior CEK).
- [ ] Confirm envelope issuance AND serving both gate on live `hasCapability`.
- [ ] Confirm revoke and expiry both drive `hasCapability` to false.
- [ ] Confirm the test asserts B cannot obtain the epoch-(e+1) key by any path, and the old-plaintext
      caveat is a note, not a pass condition.
