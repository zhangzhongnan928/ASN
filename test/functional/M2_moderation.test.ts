/**
 * M2 exit (spec §12.1): clients subscribed to DIFFERENT labelers see DIFFERENT filtering of the same
 * content; unsubscribing yields the raw stream. Plus: labels are signed (forged labels rejected),
 * moderation log is signed + append-only, and block events act as a user-controlled feed preference.
 */
import { describe, it, expect } from "vitest";
import {
  SignedLabeler,
  RuleLabeler,
  RULES,
  LabelSubscription,
  verifyLabel,
  Moderator,
  ModerationLog,
  type SignedLabel,
} from "@asn/labeler";
import type { Hex } from "viem";

const L1_KEY = ("0x" + "11".repeat(32)) as Hex;
const L2_KEY = ("0x" + "22".repeat(32)) as Hex;
const USER_KEY = ("0x" + "33".repeat(32)) as Hex;

// minimal feed items
const items = [
  { agentId: 100n, pubId: 1n }, // spammy
  { agentId: 200n, pubId: 1n }, // nsfw
  { agentId: 300n, pubId: 1n }, // benign
];
const text = (a: bigint): string =>
  a === 100n ? "buy now free money airdrop claim" : a === 200n ? "this is nsfw, explicit-content-tag" : "a normal post";

async function allLabels(labelers: RuleLabeler[]): Promise<SignedLabel[]> {
  const out: SignedLabel[] = [];
  for (const it of items) {
    for (const l of labelers) out.push(...(await l.labelTarget(`pub:${it.agentId}:${it.pubId}`, text(it.agentId), 1000)));
  }
  return out;
}

describe("M2 — composable moderation", () => {
  it("different labeler subscriptions produce different filtering; unsubscribe => raw", async () => {
    const spamLabeler = new RuleLabeler(new SignedLabeler(L1_KEY, "spam-v0"), [RULES.spam]);
    const nsfwLabeler = new RuleLabeler(new SignedLabeler(L2_KEY, "nsfw-v0"), [RULES.nsfw]);
    const labels = await allLabels([spamLabeler, nsfwLabeler]);

    // subscribe to spam labeler only → spam item hidden, nsfw shown
    const sub1 = new LabelSubscription();
    sub1.subscribe(spamLabeler.address);
    const d1 = await sub1.apply(items, labels);
    expect(d1.find((d) => d.item.agentId === 100n)!.decision).toBe("hidden");
    expect(d1.find((d) => d.item.agentId === 200n)!.decision).toBe("show"); // not subscribed to nsfw labeler

    // subscribe to nsfw labeler only → nsfw warned, spam shown
    const sub2 = new LabelSubscription();
    sub2.subscribe(nsfwLabeler.address);
    const d2 = await sub2.apply(items, labels);
    expect(d2.find((d) => d.item.agentId === 200n)!.decision).toBe("warn");
    expect(d2.find((d) => d.item.agentId === 100n)!.decision).toBe("show");

    // subscribe to both → both flagged
    const sub3 = new LabelSubscription();
    sub3.subscribe(spamLabeler.address);
    sub3.subscribe(nsfwLabeler.address);
    const d3 = await sub3.apply(items, labels);
    expect(d3.find((d) => d.item.agentId === 100n)!.decision).toBe("hidden");
    expect(d3.find((d) => d.item.agentId === 200n)!.decision).toBe("warn");

    // unsubscribe all → raw stream (everything shown)
    sub3.unsubscribeAll();
    const raw = await sub3.apply(items, labels);
    expect(raw.every((d) => d.decision === "show")).toBe(true);
  });

  it("forged labels are rejected even when their claimed labeler is subscribed", async () => {
    const labeler = new RuleLabeler(new SignedLabeler(L1_KEY, "spam-v0"), [RULES.spam]);
    const [good] = await labeler.labelTarget("pub:100:1", text(100n), 1000);
    expect(await verifyLabel(good!)).toBe(true);

    // tamper: keep the labeler address + claim, but corrupt the signature
    const forged: SignedLabel = { ...good!, category: "prohibited", sig: ("0x" + "00".repeat(65)) as Hex };
    expect(await verifyLabel(forged)).toBe(false);

    const sub = new LabelSubscription();
    sub.subscribe(labeler.address);
    const decisions = await sub.apply(items, [forged]);
    // forged label dropped → item shown (not hidden)
    expect(decisions.find((d) => d.item.agentId === 100n)!.decision).toBe("show");
  });

  it("moderation log is signed + append-only; denylist tracked; forged entry rejected", async () => {
    const mod = new Moderator(L1_KEY);
    const log = new ModerationLog();
    const e = await mod.sign(log.nextSeq(), "denylist", "cid:bafyBad", "illegal", 1000);
    await log.append(e);
    expect(log.isDenylisted("cid:bafyBad")).toBe(true);
    expect(log.list().length).toBe(1);

    const forged = { ...e, seq: 1, target: "cid:bafyOther", sig: ("0x" + "00".repeat(65)) as Hex };
    await expect(log.append(forged)).rejects.toBeTruthy();
    expect(log.isDenylisted("cid:bafyOther")).toBe(false);
  });

  // (signed social events incl. block/like + replay/inheritance hardening: see Social_events.test.ts)
});
