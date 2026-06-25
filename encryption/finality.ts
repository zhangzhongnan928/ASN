/**
 * Finality source (spec v0.3 R2 P0-A). Key release is IRREVERSIBLE: once a CEK is delivered it cannot
 * be un-delivered. So authorization (TBA control + capability) MUST be evaluated against a finalized
 * (or configured "safe") block, never an unsafe head that a reorg could orphan. The product trade-off:
 * a finality delay (slower first read) buys irreversible-safe key release.
 */
import type { Hex } from "@asn/shared";

export interface BlockRef {
  number: bigint;
  hash: Hex;
}

export interface FinalitySource {
  /** The current finalized block the key service authorizes against. */
  finalized(): Promise<BlockRef>;
  /** Canonical hash at a given height, or null if unknown/orphaned (for blockHash cross-checks). */
  blockHashAt(n: bigint): Promise<Hex | null>;
}

/** Deterministic finality for tests: a canonical chain + a movable finalized pointer + reorg support. */
export class InMemoryFinality implements FinalitySource {
  private hashes = new Map<bigint, Hex>(); // canonical height -> hash
  private finalizedNumber = 0n;

  /** Append/define a canonical block. */
  setBlock(n: bigint, hash: Hex): this {
    this.hashes.set(n, hash);
    return this;
  }

  /** Mark everything up to `n` finalized. */
  setFinalized(n: bigint): this {
    this.finalizedNumber = n;
    return this;
  }

  /** Reorg: drop canonical blocks at or above `fromHeight` (they become orphaned). */
  reorgFrom(fromHeight: bigint): this {
    for (const h of [...this.hashes.keys()]) if (h >= fromHeight) this.hashes.delete(h);
    if (this.finalizedNumber >= fromHeight) this.finalizedNumber = fromHeight - 1n;
    return this;
  }

  async finalized(): Promise<BlockRef> {
    const hash = this.hashes.get(this.finalizedNumber);
    if (!hash) throw new Error(`no canonical hash at finalized height ${this.finalizedNumber}`);
    return { number: this.finalizedNumber, hash };
  }

  async blockHashAt(n: bigint): Promise<Hex | null> {
    return this.hashes.get(n) ?? null;
  }
}

/** Reads the chain's finalized block via viem (blockTag "finalized"; falls back to "safe"). */
export class OnchainFinality implements FinalitySource {
  // Production should use "finalized" (or "safe"). "latest" is only for local chains (e.g. anvil)
  // that have no real finality — it weakens the P0-A guarantee and must not be used in production.
  constructor(
    private readonly client: {
      getBlock(args: { blockTag?: "finalized" | "safe" | "latest"; blockNumber?: bigint }): Promise<{ number: bigint | null; hash: Hex | null }>;
    },
    private readonly tag: "finalized" | "safe" | "latest" = "finalized",
  ) {}

  async finalized(): Promise<BlockRef> {
    const b = await this.client.getBlock({ blockTag: this.tag });
    return { number: b.number!, hash: b.hash! };
  }

  async blockHashAt(n: bigint): Promise<Hex | null> {
    try {
      const b = await this.client.getBlock({ blockNumber: n });
      return b.hash;
    } catch {
      return null;
    }
  }
}
