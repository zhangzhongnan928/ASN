# ASN — Internal Security Review

> ⚠️ **This is an INTERNAL self-review, NOT an external audit.** It was produced by an AI agent running
> adversarial finders + verifiers over the code, plus the automated test suite. A passing test count and
> an agent's own "confirmed/dismissed" verdicts **do not constitute** a professional security audit.
> Before any real value is at stake, an independent audit (e.g. the `smart-contract-audit` skill +
> Trail of Bits tooling) must be run over AgentID / CapabilityToken / Publications / ASNPaymaster **and
> the new ERC-6551 TBA integration** (ASNTokenBoundAccount / TBAKeyRegistry / the TBA-gated key service).
> Do not self-release on the basis of this document.
>
> Scope note: the findings below are from **round 1** (pre-ERC-6551). The round-2 TBA rewrite has NOT
> yet had an equivalent independent audit pass — that is the next required step.

---

After the round-1 adversarial gate went green, a second internal review was run per
`adversarial-test-spec.md` ("与既有工具的衔接"): a static review over AgentID /
CapabilityToken / Publications / ASNPaymaster + the security-critical off-chain modules, to find holes
**not** covered by the adversarial tests (reentrancy / access control / storage collision / proxy /
crypto / trust-boundary). The directive's `smart-contract-audit` skill is not present in this
environment, so an equivalent adversarial audit was run: auditors fan out by (target × dimension),
and **every** finding is independently re-verified against the actual code + tests before it counts.

- Raw findings: **13** · confirmed by an independent verifier: **7** · dismissed (false-positive /
  info): **6**.
- **P0 result:** every CapabilityToken and encryption finding was dismissed as false-positive or
  info. The capability-authorization logic (P0 #1) and key-epoch encryption (P0 #2) had **no
  confirmed defects**. The confirmed issues are all in peripheral areas.

## Confirmed findings & resolutions (all fixed)

| # | Sev | Area | Finding | Fix | Test |
|---|-----|------|---------|-----|------|
| 1 | med | ASNPaymaster | Budget reservation race: `globalSpent`/`senderSpent` only debited in `postOp`, so multiple ops in one EntryPoint bundle each pass the budget check against stale state → budget overshoot. | Added `globalReserved`/`senderReserved`; reserve `maxCost` in `validatePaymasterUserOp`, release in `postOp`; budget check uses `spent + reserved + maxCost`. | `AT6_PaymasterPolicy.t.sol::test_intraBundleBudgetNotOvershot`, `…SucceedsAndReleasesReservation` |
| 2 | med | indexer/social | Like counts inflatable by replaying one valid signed event (no dedup/nonce). | Likes stored as `Map<target, Set<actor>>`; `likeCount` = set size (idempotent per actor). | `M2_moderation.test.ts` (like-replay assertion) |
| 3 | med | indexer/social | Actor spoofable: a signature proves "signer signed", not "signer owns actor"; `ownerOf` binding was optional. | Made the `OwnerResolver` **mandatory** in `ingest`; reject when `ownerOf(actor) != signer`. | `M2_moderation.test.ts` (actor-spoof rejected) |
| 4,5 | low | ASNPaymaster | (same root cause as #1 — global/sender budget enforceable only between bundles). | Closed by #1's reservation. | as #1 |
| 6 | low | mcp/trust | `OwnerAuthorization` bound the tool name but not the params, so a compromised agent could redirect an owner's authorization to different params (e.g. a different grantee). | `OwnerSession.consume` now also compares `canonicalParams(intent.params)` to the actual params; all write tools pass their real params. | `M0_mcp_web.test.ts` (params-mismatch rejected) |
| 7 | low | indexer | Forward-sync did not cross-check `event.blockHash` against the canonical hash for that height (orphan-admit race vs a real RPC). | Forward loop now rejects any event whose `blockHash` ≠ the recorded canonical hash for its block number. | covered by `AT8_reorg.test.ts` |

## Hardening (info-level, applied anyway — strengthens P0 encryption)

- **AEAD context binding.** Content is now AEAD-bound to `contentAAD(resourceId, epoch)` and key
  envelopes to `envelopeAAD(resourceId, epoch, granteeAgentId)`. This prevents any cross-context reuse
  of a ciphertext or a key envelope (e.g. replaying an envelope at a different epoch/grantee).
  Verified by `AT1_no_capability.test.ts` (cross-context unwrap throws) and the unchanged AT-3 core.

## Dismissed (verifier rejected as not-real / informational)

- AgentID stale metadata URI across transfer (info — by design, new owner can reset).
- `hasCapabilityForHolder` for a nonexistent grantee (false-positive — returns false via safe lookup).
- `grant` does not reject `granteeAgentId == 0` (info — owner's choice; 0 is just an unused id).
- Pagination "restarts from top" after a reorg orphans the cursor item (false-positive — cursor is
  position-based; no dup/gap, re-query is consistent).
- MCP "content cannot mint authorizations" (false-positive — that's the verified property, not a bug).

Both gates pass: adversarial (8/8 attacks blocked) **and** internal review (all confirmed findings fixed).

---

## Round-2 internal review (ERC-6551 TBA + P1 changes)

A second internal review (same find→adversarially-verify method) was run over the R2 surface
(`ASNTokenBoundAccount`, `TBAKeyRegistry`, the TBA key service, finality, ECIES, social, mint, policy):
**18 findings, 5 confirmed, 13 dismissed.** It caught a **CRITICAL** correctness/authorization break
that the test suite missed — exactly the value of this gate. All 5 are fixed + regression-tested.

| # | Sev | Area | Finding | Fix | Test |
|---|-----|------|---------|-----|------|
| 1 | **critical** | TBA key service | `granteeAgentId` (capability) and `granteeTBA` (control/envelope) were **unbound** — a revoked party controlling its own TBA could "borrow" a third party's live capability and read | derive the canonical TBA from `granteeAgentId` (drop caller-supplied TBA); bind `granteeAgentId` into challenge + envelope AAD + transport AAD | `TBA_borrow_capability.test.ts` |
| 2 | high | (same root cause, key-service-gating view) | as #1 | closed by #1 | as #1 |
| 3 | high | social | a former owner could pin a relation with a huge pre-transfer `seq` the new owner couldn't override (seq-only LWW) | order LWW by **(block, seq, sig)** — a later-block event always wins | `P1A_social_events.test.ts` (poison test) |
| 4 | low | encryption oracle (test mirror) | `InMemoryCapabilityOracle` expiry used wall-clock, not the evaluated block's time | `setBlockTime`; compare expiry against the block's timestamp (clock fallback) | `AT3_revoke_rotate.test.ts` |
| 5 | low | mint | `mintTo` acceptance lacked EIP-712 domain ⇒ cross-chain / cross-deployment replay | real EIP-712 domain (chainId + `address(this)`) in `mintAcceptDigest` | `P1B_MintGrief.t.sol` (cross-deploy rejected) |

Notable **dismissed** (verifier rejected): owner() reverting on burned NFT (info), ECIES low-order/
all-zero rejection correct, AEAD nonce/AAD sound, `registerKey` gating correct, policy fail-open
simulation is optional-by-design, `OnchainFinality` "latest" only used in tests.

⚠️ This R2 internal review is **diligence, not a substitute** for the human-run external audit, which is
the next required step over the contracts + the new TBA integration.
