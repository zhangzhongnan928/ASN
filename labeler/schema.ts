/**
 * Signed label schema (spec v0.3 §7). Labels are signed assertions about a target (a publication or
 * an agent). Clients subscribe to labelers they trust; unsubscribing yields the raw stream. The
 * protocol layer never censors — labels are an opt-in overlay (§11.1, non-gatekeeper).
 */
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage, type Address, type Hex } from "viem";

export type LabelAction = "hide" | "warn" | "inform";

/** Fixed taxonomy (MVP). A real deployment versions this and records model/policy version (§7.3). */
export type LabelCategory =
  | "spam"
  | "nsfw"
  | "prohibited"
  | "prompt-injection"
  | "scam"
  | "misinfo"
  | "other";

export interface LabelValue {
  /** "pub:<agentId>:<pubId>" | "agent:<agentId>" | "cid:<cid>" */
  target: string;
  action: LabelAction;
  category: LabelCategory;
  reason?: string;
  ts: number;
  /** taxonomy/policy version for auditability */
  policy: string;
}

export interface SignedLabel extends LabelValue {
  labeler: Address;
  sig: Hex;
}

/** Deterministic serialization for signing/verification. */
export function canonicalLabel(v: LabelValue, labeler: Address): string {
  return JSON.stringify({
    labeler,
    target: v.target,
    action: v.action,
    category: v.category,
    reason: v.reason ?? "",
    ts: v.ts,
    policy: v.policy,
  });
}

export class SignedLabeler {
  private readonly account;
  constructor(privateKey: Hex, readonly policy = "asn-default-v0") {
    this.account = privateKeyToAccount(privateKey);
  }
  get address(): Address {
    return this.account.address;
  }
  async sign(v: Omit<LabelValue, "policy"> & { policy?: string }): Promise<SignedLabel> {
    const value: LabelValue = { ...v, policy: v.policy ?? this.policy };
    const sig = await this.account.signMessage({ message: canonicalLabel(value, this.account.address) });
    return { ...value, labeler: this.account.address, sig };
  }
}

/** Verify a label's signature really came from its claimed labeler. Forged labels are rejected. */
export async function verifyLabel(label: SignedLabel): Promise<boolean> {
  try {
    return await verifyMessage({
      address: label.labeler,
      message: canonicalLabel(label, label.labeler),
      signature: label.sig,
    });
  } catch {
    return false;
  }
}

const STRENGTH: Record<LabelAction, number> = { inform: 1, warn: 2, hide: 3 };
export function strongestAction(actions: LabelAction[]): LabelAction | null {
  if (actions.length === 0) return null;
  return actions.reduce((a, b) => (STRENGTH[b] > STRENGTH[a] ? b : a));
}
