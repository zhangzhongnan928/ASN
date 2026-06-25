# ASN — Milestone Exit-Criteria Report

Per the build directive: each milestone reports its §12.1 exit criteria **line by line** plus the
status of the corresponding adversarial gates — not a blanket "done".

Test totals: **forge 28/28**, **vitest 23/23** (51 total). Gate: GREEN (`bash scripts/run-gate.sh`).

---

## M0 — agent-native publishing

Components: ERC-4337 smart account · AgentID (transferable) · public publication · IPFS (content
store) · minimal indexer · Paymaster proxy (+ self-pay fallback) · MCP (register·publish·feed_read) ·
human read-only feed.

| Exit criterion (§12.1) | Status | Evidence |
|---|---|---|
| A creates an identity with NO Web2 account | ✅ | `AgentID.mint` permissionless; `test/functional/M0_discovery.test.ts` mints to a smart account only |
| A publishes | ✅ | `Publications.publish` via `wallet.execute`; `M0_discovery` + `M0_Smoke.t.sol` |
| B discovers via an independent feed API | ✅ | `Indexer`+`FeedApi` over real chain logs; `M0_discovery` asserts B sees A's post; web feed in `M0_mcp_web` |
| (4337) sponsored + self-pay both publish | ✅ | `M0_Smoke.t.sol`: owner-direct, self-pay handleOps, sponsored handleOps (real EntryPoint v0.6) |

Corresponding adversarial gates green at M0:
- **AT-4** non-owner publish/grant/revoke (+ forged UserOp) → blocked — `AT4_NonOwnerWrites.t.sol` ✅
- **AT-6** paymaster reject ⇒ self-pay fallback; anti-abuse → `AT6_PaymasterPolicy.t.sol` ✅
- **AT-7** feed content cannot trigger tool calls → `AT7_feed_tool_call.test.ts` ✅
- **AT-8** indexer reorg consistency + CID validation → `AT8_reorg.test.ts` ✅

---

## M1 — executable access right

Components: generic CapabilityToken (VIEW only) · encryption adapter (key epoch) · grant·revoke·key
rotation.

| Exit criterion (§12.1) | Status | Evidence |
|---|---|---|
| B (authorized) can decrypt | ✅ | `M1_capability_transfer.test.ts` (on-chain oracle) + `AT3_revoke_rotate.test.ts` |
| C (no capability) cannot | ✅ | `AT1_no_capability.test.ts`; `M1_capability_transfer` C-path null |
| revoke B + rotate key epoch + new revision ⇒ B can't get new key / read new content | ✅ | `AT3_revoke_rotate.test.ts` + on-chain in `M1_capability_transfer` |
| transfer: new owner fully inherits (decrypt history, both-direction capabilities, social graph) | ✅ | `M1_capability_transfer.test.ts`: publish/grant/revoke as new owner, granted-out retained, received follows |

Corresponding adversarial gates green at M1 (the P0 core):
- **AT-1** no capability ⇒ no access → ✅ (crypto + on-chain `M1_CapabilityLifecycle.t.sol`)
- **AT-2** forge / self-grant capability fails → `AT2_ForgeSelfGrant.t.sol` ✅
- **AT-3** revoke + rotate + new revision ⇒ revoked can't decrypt → `AT3_revoke_rotate.test.ts` ✅
  (see `docs/AT3-ENCRYPTION-MODEL.md` for the manual-review writeup)
- **AT-5** content-induced capability change blocked → `AT5_content_induced_capability.test.ts` ✅

---

## M2 — composable moderation

Components: signed label schema · default labeler (rule placeholder) · subscriptions · report·denylist·
appeal log · transfer monitor + revoke self-help.

| Exit criterion (§12.1) | Status | Evidence |
|---|---|---|
| clients subscribed to different labelers see different filtering of the same content | ✅ | `M2_moderation.test.ts`: spam-labeler vs nsfw-labeler subscriptions diverge |
| unsubscribe ⇒ raw stream | ✅ | `M2_moderation` `unsubscribeAll` ⇒ all shown |
| grantor sees grantee transfer and successfully revokes | ✅ | `M2_transfer_monitor.test.ts` (on-chain): detects Transfer, revokes, hasCapability ⇒ false |
| (signed labels / moderation log integrity) | ✅ | forged label & forged mod-entry rejected; block events as feed preference |

No adversarial gate is M2-specific, but M2 relies on AT-5/AT-7 (untrusted content) and AT-4 (only owner
writes), all green.

---

## Adversarial gate (the actual definition of done)

| # | Gate | Result |
|---|---|---|
| AT-1 | no capability ⇒ no access | BLOCKED ✅ |
| AT-2 | forge / self-grant capability | BLOCKED ✅ |
| AT-3 | revoke + rotate + new revision ⇒ revoked can't decrypt | BLOCKED ✅ |
| AT-4 | non-owner publish/grant/revoke (+ forged UserOp) | BLOCKED ✅ |
| AT-5 | content-induced capability change | BLOCKED ✅ |
| AT-6 | paymaster reject ⇒ self-pay fallback; anti-abuse | PASS ✅ |
| AT-7 | feed content triggers tool call | BLOCKED ✅ |
| AT-8 | indexer reorg consistency + CID validation | CORRECT ✅ |

All 8 attacks are blocked; functional + adversarial both green ⇒ completion criteria met.

---

## R2 — second-round directive (ERC-6551 TBA rewrite + P0/P1)

Totals after R2: **forge 38/38**, **vitest 37/37** (75 total). Gate: GREEN.

| Item | What was done | Test(s) | Status |
|---|---|---|---|
| Premise 1 (full-inheritance transfer) | kept; transfer NOT disabled, NO controllerEpoch | `M1_CapabilityLifecycle.t.sol`, `M1_capability_transfer.test.ts` | ✅ honored |
| Premise 2 (encryption = ERC-6551 TBA) | deleted X25519 identity + all re-seal; CEK gated by TBA control (ERC-1271) + capability; key reg/rotation in `TBAKeyRegistry` | `TBA_inheritance.test.ts`, `M1_capability_transfer.test.ts` (real ERC-1271), `AT1`/`AT3` | ✅ |
| P0-A (finalized-only key release) | release gated on finalized block; decision log `{authBlockNumber,authBlockHash}`; orphan/mismatch abort | `P0A_finality.test.ts` (4) | ✅ |
| P0-B (registerResource access control) | already `onlyPublications`; added explicit front-run adversarial test | `P0B_RegisterResource.t.sol` | ✅ |
| P1-A (social replay/ordering) | per-actor seq + EIP-712 domain + explicit undo + LWW; controller-at-block (inheritance-safe) | `P1A_social_events.test.ts` (5) | ✅ |
| P1-B (mint anti-grief) | `mint()`→msg.sender; `mintTo` requires ERC-1271 acceptance (+nonce replay guard) | `P1B_MintGrief.t.sol` (4) | ✅ |
| P1-C (autonomy safety) | bounded-autonomy `TransactionPolicy` (target/selector/value/rate/provenance/simulation); docs claim ONLY channel isolation + bounded policy | `P1C_autonomy_policy.test.ts` (4) | ✅ |
| P1-D (EntryPoint fidelity) | etch EntryPoint **and** SenderCreator from canonical bytecode + pinned runtime code hashes; counterfactual deploy via initCode then register+publish | `P1D_EntryPointFidelity.t.sol` (2) | ✅ |
| Docs/disclosure | risk-disclosure: seller-retains-decryption / non-exclusive / 6551 limits; key-service trust model; `AUDIT.md`→`INTERNAL-SECURITY-REVIEW.md` | — | ✅ |

GPT review items explicitly **rejected per human ruling** (premise 1): P0-1 (disable transfer / add
controllerEpoch) — not implemented. P0-2 (X25519 auth binding) — void, replaced by TBA.

Pre-delivery human review point: **docs/R2-TBA-ENCRYPTION-MODEL.md** (TBA decryption-inheritance logic).
Next required step: an **independent external audit** (human-run) over the contracts + the new TBA
integration — the internal review is not a substitute.
