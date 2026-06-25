/**
 * R2 P1-C — bounded-autonomy transaction policy (defense-in-depth beyond channel isolation).
 *
 * Even an autonomous planner holding a valid authorization is constrained: out-of-policy writes
 * (non-allowlisted target/selector, over value cap, over rate, missing provenance, failing simulation)
 * are BLOCKED. "Attack succeeds" iff such a write executes. (spec v0.3 R2 P1-C.)
 */
import { describe, it, expect } from "vitest";
import { TransactionPolicy, type WriteAction } from "@asn/mcp";

const PUBLICATIONS = ("0x" + "11".repeat(20)) as `0x${string}`;
const PUBLISH_SEL = "0x1a2b3c4d" as `0x${string}`;
const GRANT_SEL = "0x5e6f7a8b" as `0x${string}`;
const ROGUE = ("0x" + "de".repeat(20)) as `0x${string}`;
const prov = { origin: "autonomous-planner", reason: "scheduled post" };

const action = (over: Partial<WriteAction> = {}): WriteAction => ({
  tool: "publish",
  target: PUBLICATIONS,
  selector: PUBLISH_SEL,
  value: 0n,
  provenance: prov,
  ...over,
});

describe("R2 P1-C — bounded autonomy policy", () => {
  it("allows an in-policy write and records provenance", async () => {
    const policy = new TransactionPolicy({ maxPerWindow: 5 }).allow(PUBLICATIONS, [PUBLISH_SEL], 0n);
    let ran = false;
    const out = await policy.guard(action(), async () => {
      ran = true;
      return "ok";
    });
    expect(out.executed).toBe(true);
    expect(ran).toBe(true);
    expect(policy.auditLog.length).toBe(1);
    expect(policy.auditLog[0]!.provenance?.origin).toBe("autonomous-planner");
  });

  it("blocks out-of-policy writes (target / selector / value / provenance)", async () => {
    const policy = new TransactionPolicy().allow(PUBLICATIONS, [PUBLISH_SEL], 0n);
    const tries: Array<[WriteAction, RegExp]> = [
      [action({ target: ROGUE }), /target not allowlisted/],
      [action({ selector: GRANT_SEL }), /selector not allowlisted/],
      [action({ value: 1n }), /value exceeds cap/],
      [action({ provenance: undefined }), /provenance/],
    ];
    for (const [a, re] of tries) {
      let ran = false;
      const out = await policy.guard(a, async () => {
        ran = true;
        return 1;
      });
      expect(out.executed).toBe(false);
      expect(out.reason).toMatch(re);
      expect(ran).toBe(false);
    }
    expect(policy.auditLog.length).toBe(0);
  });

  it("enforces a rate limit", async () => {
    let t = 0;
    const policy = new TransactionPolicy({ maxPerWindow: 2, windowMs: 1000, now: () => t }).allow(PUBLICATIONS, [PUBLISH_SEL], 0n);
    expect((await policy.guard(action(), async () => 1)).executed).toBe(true);
    expect((await policy.guard(action(), async () => 1)).executed).toBe(true);
    const third = await policy.guard(action(), async () => 1);
    expect(third.executed).toBe(false);
    expect(third.reason).toMatch(/rate limit/);
    // after the window rolls over, allowed again
    t = 2000;
    expect((await policy.guard(action(), async () => 1)).executed).toBe(true);
  });

  it("blocks when pre-execution simulation fails", async () => {
    const policy = new TransactionPolicy().allow(PUBLICATIONS, [PUBLISH_SEL], 0n);
    let ran = false;
    const out = await policy.guard(
      action(),
      async () => {
        ran = true;
        return 1;
      },
      async () => ({ ok: false, reason: "would revert" }),
    );
    expect(out.executed).toBe(false);
    expect(out.reason).toMatch(/simulation failed/);
    expect(ran).toBe(false);
  });
});
