/**
 * Off-chain paymaster proxy: sponsor → self-pay fallback orchestration (spec §6, AT-6 off-chain half).
 * Unit-tests the decision/fallback logic, then proves the policy reads off the REAL on-chain paymaster.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { toFunctionSelector, type Address, type Hex } from "viem";
import {
  PaymasterProxy,
  OnchainPolicySource,
  DenyReason,
  SelfPayUnavailableError,
  type PolicySource,
  type SponsorCall,
} from "@asn/paymaster";
import { startChain, type ChainHarness } from "../helpers/chain.js";

const mockPolicy = (reason: DenyReason): PolicySource => ({ evaluate: async () => reason });
const call: SponsorCall = {
  sender: ("0x" + "11".repeat(20)) as Hex,
  target: ("0x" + "22".repeat(20)) as Hex,
  innerSelector: "0x12345678",
  value: 0n,
  calldataLen: 100,
  maxCost: 1000n,
};

describe("Paymaster proxy fallback orchestration", () => {
  it("plans sponsored when policy OK, self-pay when denied", async () => {
    const ok = await new PaymasterProxy(mockPolicy(DenyReason.OK)).plan(call, 10_000n);
    expect(ok.mode).toBe("sponsored");
    const denied = await new PaymasterProxy(mockPolicy(DenyReason.SENDER_BUDGET_EXCEEDED)).plan(call, 10_000n);
    expect(denied.mode).toBe("self-pay");
    expect(denied.reason).toBe(DenyReason.SENDER_BUDGET_EXCEEDED);
  });

  it("falls back to self-pay when the sponsored submit fails", async () => {
    const proxy = new PaymasterProxy(mockPolicy(DenyReason.OK));
    const plan = await proxy.plan(call, 10_000n);
    let selfPaid = false;
    const out = await proxy.submitWithFallback(
      plan,
      async () => {
        throw new Error("bundler rejected sponsorship");
      },
      async () => {
        selfPaid = true;
        return "ok";
      },
    );
    expect(out.mode).toBe("self-pay");
    expect(out.sponsoredAttempted).toBe(true);
    expect(selfPaid).toBe(true);
  });

  it("uses self-pay directly when denied", async () => {
    const proxy = new PaymasterProxy(mockPolicy(DenyReason.RATE_LIMITED));
    const plan = await proxy.plan(call, 10_000n);
    const out = await proxy.submitWithFallback(plan, async () => "sponsored", async () => "self");
    expect(out.result).toBe("self");
    expect(out.sponsoredAttempted).toBe(false);
  });

  it("throws only when sponsorship denied AND account cannot self-pay (unfunded)", async () => {
    const proxy = new PaymasterProxy(mockPolicy(DenyReason.GLOBAL_BUDGET_EXCEEDED));
    const plan = await proxy.plan(call, 0n); // no balance
    await expect(proxy.submitWithFallback(plan, async () => "s", async () => "p")).rejects.toBeInstanceOf(
      SelfPayUnavailableError,
    );
  });
});

describe("Paymaster proxy over real on-chain policy", () => {
  let chain: ChainHarness;
  beforeAll(async () => {
    chain = await startChain();
  }, 60_000);
  afterAll(async () => {
    await chain?.stop();
  });

  it("reads OK for an allowlisted publish call and TARGET_NOT_ALLOWED for a rogue target", async () => {
    const publishSel = toFunctionSelector("publish(uint256,string,bytes32,uint8)");
    const deployer = chain.keys[0]!;
    // configure: allow publish on Publications, set caps/budgets.
    await chain.send(deployer, chain.addr.paymaster, chain.abis.ASNPaymaster, "setTargetAllowed", [chain.addr.publications, true]);
    await chain.send(deployer, chain.addr.paymaster, chain.abis.ASNPaymaster, "setCallAllowed", [chain.addr.publications, publishSel, true]);
    await chain.send(deployer, chain.addr.paymaster, chain.abis.ASNPaymaster, "setCaps", [0n, 8192n, 50_000_000_000_000_000n]);
    await chain.send(deployer, chain.addr.paymaster, chain.abis.ASNPaymaster, "setBudgets", [10n ** 18n, 10n ** 18n]);

    const policy = new OnchainPolicySource(chain.publicClient as never, chain.addr.paymaster, chain.abis.ASNPaymaster);
    const proxy = new PaymasterProxy(policy);
    const sender = ("0x" + "33".repeat(20)) as Address;

    const allowed = await proxy.plan(
      { sender, target: chain.addr.publications, innerSelector: publishSel, value: 0n, calldataLen: 200, maxCost: 1_000_000_000_000_000n },
      10n ** 18n,
    );
    expect(allowed.reason).toBe(DenyReason.OK);
    expect(allowed.mode).toBe("sponsored");

    const rogue = await proxy.plan(
      { sender, target: ("0x" + "de".repeat(20)) as Address, innerSelector: publishSel, value: 0n, calldataLen: 200, maxCost: 1_000_000_000_000_000n },
      10n ** 18n,
    );
    expect(rogue.reason).toBe(DenyReason.TARGET_NOT_ALLOWED);
    expect(rogue.mode).toBe("self-pay");
  });
});
