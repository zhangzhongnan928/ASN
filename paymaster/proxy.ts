/**
 * Off-chain Paymaster proxy (spec v0.3 §6, /paymaster). Pairs with the on-chain ASNPaymaster.
 *
 * The agent's gas strategy: try sponsorship; if the policy denies (or sponsorship fails at submit
 * time), fall back to self-pay. Sponsorship is a convenience, never the only path — so the paymaster
 * can never become a gatekeeper (AT-6). The only hard requirement for the permissionless guarantee is
 * that the account can self-pay when funded.
 */
import type { Hex } from "@asn/shared";

/** Mirror of ASNPaymaster.DenyReason (keep in sync with the contract enum). */
export enum DenyReason {
  OK = 0,
  NOT_EXECUTE = 1,
  TARGET_NOT_ALLOWED = 2,
  SELECTOR_NOT_ALLOWED = 3,
  VALUE_TOO_HIGH = 4,
  CALLDATA_TOO_LONG = 5,
  COST_TOO_HIGH = 6,
  GLOBAL_BUDGET_EXCEEDED = 7,
  SENDER_BUDGET_EXCEEDED = 8,
  RATE_LIMITED = 9,
}

export interface SponsorCall {
  sender: Hex;
  target: Hex;
  innerSelector: Hex;
  value: bigint;
  calldataLen: number;
  maxCost: bigint;
}

export interface PolicySource {
  evaluate(call: SponsorCall): Promise<DenyReason>;
}

export type GasMode = "sponsored" | "self-pay";

export interface GasPlan {
  mode: GasMode;
  reason: DenyReason;
  canSelfPay: boolean;
}

export class SelfPayUnavailableError extends Error {}

export class PaymasterProxy {
  constructor(private readonly policy: PolicySource) {}

  /** Decide whether to request sponsorship or self-pay, given the account's available balance. */
  async plan(call: SponsorCall, selfPayBalance: bigint): Promise<GasPlan> {
    const reason = await this.policy.evaluate(call);
    const canSelfPay = selfPayBalance >= call.maxCost;
    if (reason === DenyReason.OK) return { mode: "sponsored", reason, canSelfPay };
    return { mode: "self-pay", reason, canSelfPay };
  }

  /**
   * Execute with fallback: attempt the sponsored path; if sponsorship is denied or fails at submit
   * time, self-pay. Throws only if BOTH sponsorship is unavailable AND the account cannot self-pay —
   * i.e. the agent is simply unfunded, never because the paymaster blocked it.
   */
  async submitWithFallback<T>(
    plan: GasPlan,
    submitSponsored: () => Promise<T>,
    submitSelfPay: () => Promise<T>,
  ): Promise<{ mode: GasMode; result: T; sponsoredAttempted: boolean }> {
    let sponsoredAttempted = false;
    if (plan.mode === "sponsored") {
      sponsoredAttempted = true;
      try {
        return { mode: "sponsored", result: await submitSponsored(), sponsoredAttempted };
      } catch {
        // sponsorship failed at submission — fall through to self-pay.
      }
    }
    if (!plan.canSelfPay) {
      throw new SelfPayUnavailableError(
        "sponsorship unavailable and account cannot self-pay (fund the smart account to publish)",
      );
    }
    return { mode: "self-pay", result: await submitSelfPay(), sponsoredAttempted };
  }
}

/** On-chain policy source backed by ASNPaymaster.evaluateCall. */
export class OnchainPolicySource implements PolicySource {
  constructor(
    private readonly client: {
      readContract(args: { address: Hex; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }): Promise<unknown>;
    },
    private readonly paymaster: Hex,
    private readonly abi: readonly unknown[],
  ) {}

  async evaluate(call: SponsorCall): Promise<DenyReason> {
    const r = await this.client.readContract({
      address: this.paymaster,
      abi: this.abi,
      functionName: "evaluateCall",
      args: [call.sender, call.target, call.innerSelector, call.value, BigInt(call.calldataLen), call.maxCost],
    });
    return Number(r) as DenyReason;
  }
}
