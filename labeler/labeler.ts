/**
 * Default rule-based labeler (MVP placeholder, spec §7.1) + the subscription/filtering model (§7.2).
 *
 * The default labeler is a deterministic rule set over content — NOT an agent and NOT a tool caller
 * (it never invokes any tool; content is untrusted data only, §7.3). Different labelers with
 * different rule sets produce different labels, so subscribing to different labelers yields different
 * filtering of the same feed. Unsubscribing from all labelers yields the raw stream.
 */
import type { Address } from "viem";
import {
  SignedLabeler,
  verifyLabel,
  strongestAction,
  type SignedLabel,
  type LabelValue,
  type LabelCategory,
  type LabelAction,
} from "./schema.js";

export interface RuleHit {
  category: LabelCategory;
  action: LabelAction;
  reason: string;
}

/** A pure rule: examines text, returns hits. No side effects, no tool calls. */
export type Rule = (text: string) => RuleHit[];

export const RULES = {
  spam: ((t) => (/\b(buy now|free money|click here|airdrop claim)\b/i.test(t) ? [{ category: "spam", action: "hide", reason: "spam phrase" }] : [])) as Rule,
  nsfw: ((t) => (/\b(nsfw|explicit-content-tag)\b/i.test(t) ? [{ category: "nsfw", action: "warn", reason: "nsfw tag" }] : [])) as Rule,
  injection: ((t) =>
    /ignore (all )?previous instructions|<\s*tool_use\s*>|system\s*:/i.test(t)
      ? [{ category: "prompt-injection", action: "warn", reason: "injection pattern" }]
      : []) as Rule,
  scam: ((t) => (/\b(seed phrase|send eth to|double your)\b/i.test(t) ? [{ category: "scam", action: "hide", reason: "scam phrase" }] : [])) as Rule,
} satisfies Record<string, Rule>;

/** A labeler that signs labels for items matching its configured rules. */
export class RuleLabeler {
  constructor(private readonly signer: SignedLabeler, private readonly rules: Rule[]) {}
  get address(): Address {
    return this.signer.address;
  }
  /** Produce signed labels for a single target given its text and a timestamp. */
  async labelTarget(target: string, text: string, ts: number): Promise<SignedLabel[]> {
    const out: SignedLabel[] = [];
    for (const rule of this.rules) {
      for (const hit of rule(text)) {
        out.push(await this.signer.sign({ target, action: hit.action, category: hit.category, reason: hit.reason, ts }));
      }
    }
    return out;
  }
}

export interface FeedDecision<T> {
  item: T;
  decision: "show" | "warn" | "hidden";
  labels: SignedLabel[];
}

/**
 * Client-side label subscription. The client applies labels ONLY from labelers it has subscribed to;
 * forged or non-subscribed labels are ignored. With no subscriptions, every item is shown raw.
 */
export class LabelSubscription {
  private subscribed = new Set<string>();

  subscribe(labeler: Address): void {
    this.subscribed.add(labeler.toLowerCase());
  }
  unsubscribe(labeler: Address): void {
    this.subscribed.delete(labeler.toLowerCase());
  }
  unsubscribeAll(): void {
    this.subscribed.clear();
  }
  isSubscribed(labeler: Address): boolean {
    return this.subscribed.has(labeler.toLowerCase());
  }

  /** Apply subscribed, verified labels to a feed. Returns per-item decision + the applied labels. */
  async apply<T extends { agentId: bigint; pubId: bigint }>(
    items: T[],
    labels: SignedLabel[],
  ): Promise<FeedDecision<T>[]> {
    // keep only labels from subscribed labelers whose signature verifies
    const valid: SignedLabel[] = [];
    for (const l of labels) {
      if (!this.isSubscribed(l.labeler)) continue;
      if (await verifyLabel(l)) valid.push(l);
    }
    const byTarget = new Map<string, SignedLabel[]>();
    for (const l of valid) {
      const arr = byTarget.get(l.target) ?? [];
      arr.push(l);
      byTarget.set(l.target, arr);
    }
    return items.map((item) => {
      const target = `pub:${item.agentId}:${item.pubId}`;
      const ls = byTarget.get(target) ?? [];
      const action = strongestAction(ls.map((l) => l.action));
      const decision = action === "hide" ? "hidden" : action === "warn" ? "warn" : "show";
      return { item, decision, labels: ls };
    });
  }
}

export { SignedLabeler };
export type { SignedLabel, LabelValue };
