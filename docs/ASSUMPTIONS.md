# ASN — Build Assumptions & Decisions

Per the build directive: where the design docs leave a decision open, decide by the
principle **permissionless / non-custodial / no gatekeeper**, and record the assumption here.

---

## A0. Toolchain & target

- **Target chain:** Base Sepolia (chainId 84532). Contracts are chain-agnostic; deploy script
  parameterizes RPC/keys. Tests run on a local EVM (forge / anvil) for determinism.
- **Smart account:** Coinbase Smart Wallet **v1.1.0** (`coinbase/smart-wallet`), which is an
  **ERC-4337 v0.6** account (uses `UserOperation`, EntryPoint at the canonical
  `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789`). We standardize the whole Solidity project on the
  dependency set bundled with that repo (OZ 5.0.2, solady 0.0.175, webauthn-sol, AA v0.6
  interfaces) so the wallet + EntryPoint + paymaster stack stays internally consistent.
- The real EntryPoint v0.6 is exercised in tests by **etching its canonical deployed runtime
  bytecode** (`test/fixtures/entrypoint_v06.hex`, fetched once from Base mainnet) at the canonical
  address — avoids an OZ v4/v5 source-compat conflict while keeping the protocol faithful.

## A1. Capability grantee = AgentId, not raw address  (resolves a spec tension)

§4.2 sketches `grant(CapType, address grantee, bytes32 resourceId, …)`, but §3.3 requires that a
**received** capability *follows the identity transfer* ("收到的 capability 跟随… 转给新 owner").
A raw `address` grantee cannot follow an AgentID-NFT sale (the NFT, not the smart-account address,
is the transferable identity). Therefore:

- Capabilities are granted **to a grantee AgentId** (`uint256`). `hasCapability` is keyed by
  AgentId, so when that AgentId's NFT transfers, the capability automatically follows the new
  owner — exactly §3.3's "received capability follows".
- The **grant authority** is the current owner of the AgentId that **controls the resource**
  (the publisher). So when the publisher's AgentID transfers, granted-out capabilities are retained
  and the new owner can revoke them — §3.3's "granted-out capability retained, grantor can revoke".
- A convenience `hasCapabilityForHolder(t, holder, granteeAgentId, resourceId)` is provided for the
  address-oriented spirit of §4.2: true iff the capability is active **and** `ownerOf(granteeAgentId)
  == holder`. The encryption key-service always knows the requester's AgentId, so it uses the
  canonical AgentId-keyed check.

This keeps capability authorization correctness (P0 #1) unambiguous and makes the full-inheritance
transfer model (§3.3) hold without any per-transfer migration code.

## A2. Resource identity & registration

- A capability **resource** is a publication, identified canonically by
  `resourceId = keccak256(abi.encode(publisherAgentId, pubId))`.
- `Publications.publish(... gated ...)` atomically calls `CapabilityToken.registerResource(resourceId,
  publisherAgentId)`. Registration binds a resourceId to its controlling AgentId and is **idempotent +
  first-writer-wins**, so an attacker cannot re-bind an existing resource (AT-2). Because pubIds are
  assigned per-publisher by `Publications` and only the publisher's owner can publish (AT-4), an
  attacker can never obtain a resourceId that maps to someone else's content but is controlled by the
  attacker.

## A3. Encryption identity = ERC-6551 TBA  (R2 — supersedes the old X25519 model)

> Full model + human-review handoff: **docs/R2-TBA-ENCRYPTION-MODEL.md**. The old per-grantee X25519
> identity (and any "re-seal on transfer") is **deleted**.

- The encryption identity of an AgentID is its **ERC-6551 Token Bound Account (TBA)** — a deterministic
  account whose address is fixed by the NFT and does not change with ownership. **KEY = control of the
  TBA = current NFT ownership**, proven via ERC-1271 (`ASNTokenBoundAccount.isValidSignature` delegates
  to `ownerOf`). Transfer ⇒ the new owner can prove control of the same TBA ⇒ inherits decryption of all
  pre-sale envelopes with NO seller cooperation and NO re-seal.
- Per (resource, epoch) the CEK is still an **independent, random** key (NOT a hash chain). The
  `TBAKeyService` releases a CEK only on (ERC-1271 TBA control) AND (`hasCapability`) AND (finalized
  state, A3a). Revoke/rotate ⇒ revoked party fails the capability gate for the new epoch ⇒ never gets
  `CEK_{e+1}`. Old plaintext already decrypted is unrecoverable (noted, not a failure — AT-3).
- Trust model (disclosed, MVP): the key service is publisher-operated + custodial; it can refuse a
  legitimate reader or leak a CEK, but cannot admit an unauthorized party. Not gatekeeper-free (see
  risk-disclosure §2.1).

## A3a. Finalized-only key release (P0-A)

A delivered CEK is irreversible, so `TBAKeyService` authorizes (control + capability) **only against a
finalized block**, records `{authBlockNumber, authBlockHash}` in the decision log + envelope AAD, and
aborts on a finalized-hash mismatch. A grant/transfer in an unsafe or orphaned block never yields a key.
This is orthogonal to AT-8 (indexer feed consistency) and independently required.

## A4. Paymaster policy is enforced on-chain

Allowlist (target+selector) / value cap / calldata cap / per-op cost cap / per-sender + global budget /
rate-limit are enforced inside `validatePaymasterUserOp` (deterministic AT-6). The **self-pay
fallback** is intrinsic: a publish is `wallet.execute(Publications, 0, publishCalldata)` and works
whether sponsored (UserOp with paymaster) or self-paid (UserOp with no paymaster / owner-direct call).
There is no code path where publishing requires the paymaster. The off-chain `/paymaster` proxy
implements the try-sponsor→on-reject→self-pay orchestration.

## A5. Permissionless minting / no gatekeeping

`AgentID.mint(smartAccount)` is open to anyone (one tool call). Identity Sybil is acceptable at the
social layer (§6) and is addressed by labelers + follow-graph filtering, not by mint-time gating.
Paymaster anti-abuse protects the *gas subsidy budget*, never identity creation.

## A6. MCP trust boundary (AT-5 / AT-7)

`feed_read` output is **untrusted data** carried on a data channel that the agent's action dispatcher
never reads as instructions. Capability changes and tool invocations require a token minted only by the
**trusted instruction channel** (the owner). No feed content — in any encoding/language — can mint that
token. Tested by feeding injection payloads and asserting zero capability changes / zero tool calls /
zero signatures.

## A7. Off-chain signed events & moderation

follow/like/repost/reply/block are **off-chain signed events** (not on-chain), collected by the indexer
for graph + ranking. Labels are **signed** by labelers; subscriptions are client-side; unsubscribing
yields the raw stream. None of this is custodial or a gatekeeper; the protocol layer (on-chain
commitments) is never censored, only infra (pin/serve) may decline — an operator boundary, not deletion.
