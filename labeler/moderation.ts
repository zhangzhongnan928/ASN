/**
 * Moderation user-controls + minimal audit log (spec §7, §11.2). NOT a gatekeeper: nothing here can
 * delete on-chain history. report/denylist/appeal are operator/user records (e.g. an operator may
 * decline to pin/serve a denylisted CID — an operator boundary, not deletion). All entries are signed
 * and append-only for auditability.
 */
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage, type Address, type Hex } from "viem";

export type ModActionType = "report" | "denylist" | "undenylist" | "appeal";

export interface ModEntry {
  seq: number;
  action: ModActionType;
  target: string; // cid:... | pub:a:p | agent:a
  by: Address;
  reason: string;
  ts: number;
  sig: Hex;
}

function canonicalMod(e: Omit<ModEntry, "sig">): string {
  return JSON.stringify({ seq: e.seq, action: e.action, target: e.target, by: e.by, reason: e.reason, ts: e.ts });
}

export class Moderator {
  private readonly account;
  constructor(privateKey: Hex) {
    this.account = privateKeyToAccount(privateKey);
  }
  get address(): Address {
    return this.account.address;
  }
  async sign(seq: number, action: ModActionType, target: string, reason: string, ts: number): Promise<ModEntry> {
    const base = { seq, action, target, by: this.account.address, reason, ts };
    const sig = await this.account.signMessage({ message: canonicalMod(base) });
    return { ...base, sig };
  }
}

export class ModerationLog {
  private entries: ModEntry[] = [];
  private denied = new Set<string>();

  /** Append a signed entry (verified). Append-only — entries are never mutated or removed. */
  async append(entry: ModEntry): Promise<void> {
    const ok = await verifyMessage({
      address: entry.by,
      message: JSON.stringify({
        seq: entry.seq,
        action: entry.action,
        target: entry.target,
        by: entry.by,
        reason: entry.reason,
        ts: entry.ts,
      }),
      signature: entry.sig,
    });
    if (!ok) throw new Error("moderation entry signature invalid");
    this.entries.push(entry);
    if (entry.action === "denylist") this.denied.add(entry.target);
    if (entry.action === "undenylist") this.denied.delete(entry.target);
  }

  isDenylisted(target: string): boolean {
    return this.denied.has(target);
  }
  list(): ReadonlyArray<ModEntry> {
    return this.entries;
  }
  nextSeq(): number {
    return this.entries.length;
  }
}
