# R2 — ERC-6551 TBA Decryption-Inheritance Model — Human Review Handoff

> The R2 directive flags this as **the** thing to review by hand, not on automated tests alone:
> "6551 TBA 解密继承逻辑(转让后新 owner 自动解历史、控制权门控、TBA 名下 key 登记/轮换)". This document
> lays out the implementation so a human can confirm full-inheritance actually holds at the crypto layer.
> It supersedes the old X25519 model in `AT3-ENCRYPTION-MODEL.md` for the **gating mechanism** (the
> per-epoch CEK independence property is unchanged).

**On-chain code:** `contracts/ASNTokenBoundAccount.sol`, `contracts/TBAKeyRegistry.sol`,
`lib/erc6551/src/ERC6551Registry.sol` (reference registry).
**Off-chain code:** `encryption/tbaControl.ts`, `encryption/tbaKeyService.ts`, `encryption/finality.ts`,
`encryption/oracle.ts`, `encryption/crypto.ts`, `encryption/publication.ts`.
**Tests:** `test/adversarial/TBA_inheritance.test.ts`, `test/adversarial/P0A_finality.test.ts`,
`test/adversarial/AT1_no_capability.test.ts`, `test/adversarial/AT3_revoke_rotate.test.ts`,
`test/functional/M1_capability_transfer.test.ts` (real on-chain ERC-1271).

---

## 0. What changed from round 1 (and why)

Round 1 sealed CEKs to each grantee's free-floating **X25519** key. That key was the grantee's
encryption identity — and it did **not** move when the AgentID NFT transferred, so "received capability
follows the identity" was only true on-chain, not at the crypto layer (the new owner couldn't actually
decrypt without the old key). That whole model — `EncryptionKeyRegistration`, per-grantee X25519
identity, and any "re-seal on transfer" — has been **deleted**. There is no `re-seal` concept anymore.

Replacement: the encryption identity is the AgentID's **ERC-6551 Token Bound Account (TBA)**.

## 1. The core invariant

> **KEY = control of the TBA = current ownership of the AgentID NFT.**

- Each AgentID NFT has a deterministic TBA (`ERC6551Registry.account(impl, salt, chainId, AgentID,
  tokenId)`). The TBA address is fixed by the NFT and **does not change** with ownership.
- `ASNTokenBoundAccount.owner()` returns `IERC721(AgentID).ownerOf(tokenId)` — i.e. the CURRENT owner.
- `ASNTokenBoundAccount.isValidSignature(hash, sig)` (ERC-1271) returns the magic value iff `sig` is
  valid for `owner()` (via OZ `SignatureChecker`, which handles both EOA and smart-account/ERC-1271
  owners — our owners are Coinbase Smart Wallets, so it chains into CBSW's ERC-1271).

So "prove you control this TBA right now" is decided purely by current on-chain ownership, and that
proof capability **transfers with the NFT automatically**.

## 2. How a CEK is delivered (and why inheritance needs no re-seal)

CEKs are per-(resource, epoch), **independent random** keys (unchanged AT-3 property — see §5).

- **At rest:** the publisher's key service seals a CEK to the grantee's TBA-registered encryption
  pubkey (`TBAKeyService.sealFor`, ECIES). This envelope is created **once**.
- **On read:** the requester supplies ONLY `granteeAgentId` (+ an ephemeral transport key). The service
  derives the **canonical TBA** for that AgentId via a `TBAResolver` (ERC-6551 `account(...)`), and
  releases the CEK only when ALL THREE gates pass:
  1. **TBA control** — the requester signs the service-issued `controlChallenge(resourceId, epoch,
     granteeAgentId, derivedTBA, …)`; verified via the real `TBA.isValidSignature` (ERC-1271) at the
     finalized block.
  2. **Capability** — `hasCapability(VIEW, granteeAgentId, resourceId)` at the finalized block.
  3. **Finality (P0-A)** — both reads are taken at a finalized block; see §4.
  On success it re-wraps the CEK to the requester's ephemeral transport key and logs the decision.

  > **Critical binding (internal-review CRITICAL fix):** control, capability, and envelope are all keyed
  > to the SAME identity because the TBA is *derived* from `granteeAgentId`, not supplied independently.
  > Without this, a revoked party controlling its own TBA could pair its control with a third party's
  > still-live capability ("borrow a capability") and read. The challenge + envelope AAD + transport AAD
  > all include `granteeAgentId`. Regression test: `test/adversarial/TBA_borrow_capability.test.ts`.

**Inheritance, step by step (no seller cooperation):**
1. A grants B; the CEK is sealed once to B's TBA. B reads it by proving control of B's TBA.
2. B **sells** the AgentID NFT to a buyer. The TBA address is unchanged; nothing is re-sealed; B does
   nothing.
3. The buyer now satisfies `TBA.isValidSignature` (they are the current owner) ⇒ the service releases
   the SAME envelope's CEK to them. The buyer reads B's pre-sale history.
4. B (old owner) can no longer satisfy `TBA.isValidSignature` ⇒ the service refuses B.

This is verified end-to-end against the REAL contracts in `M1_capability_transfer.test.ts` (B reads;
C with no capability denied; transfer; new owner reads the same pre-sale envelope; old owner denied;
revoke+rotate cuts off the new revision).

## 3. TBA-named key registration + rotation

`TBAKeyRegistry.registerKey(tba, pubkey)` is gated on `IERC6551Account(tba).isValidSigner(msg.sender,
"")` — i.e. only the current TBA controller (the NFT owner, acting as `msg.sender`) may set/rotate the
key. Rotation is the same call with a new pubkey (version increments). Rotation exists for the
leaked-key scenario: it changes the encryption key used for **future** envelopes. It cannot un-leak
already-published content (disclosed in `risk-disclosure-draft.md §2`).

## 4. P0-A — finalized-only release (orthogonal to 6551, still mandatory)

A delivered CEK is irreversible. `TBAKeyService.requestKey`:
- resolves the **finalized** block (`FinalitySource.finalized()`), and **aborts** if
  `blockHashAt(finalized.number) !== finalized.hash` (reorg/inconsistency);
- evaluates BOTH the TBA-control proof and the capability **at that finalized block**;
- records `{authBlockNumber, authBlockHash}` in the decision log and binds the transport envelope's AAD
  to `authBlockHash` (reproducible from the decision).

Consequence (tested in `P0A_finality.test.ts`): a grant or a transfer that exists only in an unsafe
block never produces a key; an orphaned grant never authorizes; a finalized-hash mismatch aborts.

## 5. AT-3 property preserved

Per-epoch CEKs are independent random keys (`ResourceKeyManager.rotate` → fresh `generateCEK()`), NOT a
hash chain. After A revokes B and rotates to epoch e+1, B fails the capability gate for epoch e+1, so
the service never releases `CEK_{e+1}`; B's retained `CEK_e` cannot decrypt the new revision
(independent keys + AEAD bound to `(resourceId, epoch)`). The inherent limit (B keeps what it already
decrypted, and the seller keeps what it could read while owner) is disclosed, not "fixed".

## 6. Trust model (disclosed, MVP)

The key service is **publisher-operated** and **custodial** over CEKs + the TBA enc privkeys. It is NOT
gatekeeper-free: it can refuse a legitimate reader or leak a CEK. What it cannot do is admit an
unauthorized party (no TBA control / no capability / not finalized ⇒ no release). A production
deployment would replace the single service with a threshold/MPC key network (e.g. Lit) to remove the
custodial trust; the on-chain `hasCapability` + ERC-1271 control remain the authority either way.
(`risk-disclosure-draft.md §2.1`.)

---

## Reviewer checklist

- [ ] `ASNTokenBoundAccount.owner()` returns the CURRENT `ownerOf`; `isValidSignature` delegates to it.
- [ ] `TBAKeyService.requestKey` gates on ALL of: ERC-1271 control proof, capability, finalized block.
- [ ] The at-rest envelope is sealed ONCE to the stable TBA key; there is no re-seal-on-transfer path.
- [ ] After a transfer, the new owner passes the control gate and the old owner fails it (no seller help).
- [ ] `TBAKeyRegistry.registerKey/rotate` is gated on current TBA control.
- [ ] Per-epoch CEKs are independent random; revoke+rotate denies the new epoch to the revoked party.
- [ ] Disclosure (`risk-disclosure-draft.md §2/§2.1`) correctly states: buyer inherits decryption; seller
      retains decryption (non-exclusive); the key service is custodial / not gatekeeper-free.

## Diff surface touched in R2 (encryption / capability core)

- NEW contracts: `ASNTokenBoundAccount.sol`, `TBAKeyRegistry.sol` (+ vendored `erc6551/reference`).
- AgentID: `mint(address)` → `mint()` (self-mint) + `mintTo(to, nonce, acceptance)` (P1-B).
- DELETED: `encryption/keyService.ts` (X25519 grantee identity + KeyGateway + re-seal).
- NEW: `encryption/tbaControl.ts`, `encryption/tbaKeyService.ts`, `encryption/finality.ts`.
- CHANGED: `encryption/oracle.ts` (block-aware), `encryption/crypto.ts` (ECIES point/zero-secret
  hardening), `encryption/publication.ts` (read flow via TBA key service).
- CapabilityToken: unchanged authorization logic; `registerResource` remains `onlyPublications` (P0-B,
  now with an explicit front-run adversarial test).
