/**
 * Transaction policy layer (spec v0.3 R2 P1-C).
 *
 * AT-5/AT-7 prove CHANNEL ISOLATION: untrusted feed content cannot mint an owner authorization, so it
 * cannot directly cause a write. They do NOT prove SEMANTIC autonomy safety: a semantically-compromised
 * autonomous planner could still *decide* to issue a write with an authorization it legitimately holds.
 * This layer bounds the blast radius of such a decision — every autonomous write must additionally pass:
 *   - a target + selector allowlist,
 *   - a per-action value cap,
 *   - a rate limit,
 *   - explicit tool-intent PROVENANCE (origin + reason, recorded for audit), and
 *   - an optional pre-execution SIMULATION that must succeed.
 *
 * Docs claim ONLY channel isolation + this bounded-autonomy policy — NOT full semantic safety.
 */
export interface ActionProvenance {
  /** "owner" (human-in-the-loop) | "autonomous-planner" | ... */
  origin: string;
  reason: string;
}

export interface WriteAction {
  tool: string;
  target: `0x${string}`;
  selector: `0x${string}`;
  value: bigint;
  provenance?: ActionProvenance;
}

export interface PolicyRule {
  selectors: Set<`0x${string}`>;
  valueCap: bigint;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

export class TransactionPolicy {
  private rules = new Map<string, PolicyRule>(); // target(lowercased) -> rule
  private window: Array<number> = []; // timestamps (ms) of recent allowed actions
  private maxPerWindow: number;
  private windowMs: number;
  private now: () => number;

  constructor(opts: { maxPerWindow?: number; windowMs?: number; now?: () => number } = {}) {
    this.maxPerWindow = opts.maxPerWindow ?? 10;
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  allow(target: `0x${string}`, selectors: `0x${string}`[], valueCap = 0n): this {
    this.rules.set(target.toLowerCase(), { selectors: new Set(selectors.map((s) => s.toLowerCase() as `0x${string}`)), valueCap });
    return this;
  }

  /** Pure check (no rate consumption) — used for previews. */
  check(a: WriteAction): PolicyDecision {
    if (!a.provenance || !a.provenance.origin) return { allowed: false, reason: "missing tool-intent provenance" };
    const rule = this.rules.get(a.target.toLowerCase());
    if (!rule) return { allowed: false, reason: "target not allowlisted" };
    if (!rule.selectors.has(a.selector.toLowerCase() as `0x${string}`)) return { allowed: false, reason: "selector not allowlisted" };
    if (a.value > rule.valueCap) return { allowed: false, reason: "value exceeds cap" };
    if (this.rateExceeded()) return { allowed: false, reason: "rate limit exceeded" };
    return { allowed: true, reason: "ok" };
  }

  private rateExceeded(): boolean {
    const cutoff = this.now() - this.windowMs;
    this.window = this.window.filter((t) => t >= cutoff);
    return this.window.length >= this.maxPerWindow;
  }

  /**
   * Full gate: policy check + optional simulation, consuming a rate slot on success. The action runs
   * via `execute` only if everything passes. Returns the outcome (executed + reason) and records the
   * approved action's provenance in `auditLog`.
   */
  readonly auditLog: Array<WriteAction & { ts: number }> = [];

  async guard<T>(
    a: WriteAction,
    execute: () => Promise<T>,
    simulate?: () => Promise<{ ok: boolean; reason?: string }>,
  ): Promise<{ executed: boolean; reason: string; result?: T }> {
    const decision = this.check(a);
    if (!decision.allowed) return { executed: false, reason: decision.reason };
    if (simulate) {
      const sim = await simulate();
      if (!sim.ok) return { executed: false, reason: `simulation failed: ${sim.reason ?? "reverts"}` };
    }
    this.window.push(this.now());
    this.auditLog.push({ ...a, ts: this.now() });
    const result = await execute();
    return { executed: true, reason: "ok", result };
  }
}
