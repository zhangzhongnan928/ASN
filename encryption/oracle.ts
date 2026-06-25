/**
 * CapabilityOracle — mirrors CapabilityToken.hasCapability, evaluated AS OF a finalized block (P0-A).
 * Grant/revoke that only exist in an unsafe block must not count until finalized, since a released
 * CEK is irreversible.
 */
import { CapType, type Hex } from "@asn/shared";

export interface CapabilityOracle {
  /** True iff `granteeAgentId` holds an active capability `t` over `resourceId` as of `atBlock`
   *  (timestamp resolution uses the block's time where relevant). */
  hasCapability(t: CapType, granteeAgentId: bigint, resourceId: Hex, atBlock: bigint): Promise<boolean>;
}

type Key = string;
const k = (t: CapType, g: bigint, r: Hex): Key => `${t}:${g}:${r}`;

interface CapEvent {
  block: bigint;
  kind: "grant" | "revoke";
  expiry: number; // for grant: absolute seconds (Number.POSITIVE_INFINITY = perpetual)
}

/** Deterministic, block-aware mirror of CapabilityToken. Grants/revokes are recorded with the block
 *  they took effect; `hasCapability(atBlock)` folds events with block <= atBlock. */
export class InMemoryCapabilityOracle implements CapabilityOracle {
  private events = new Map<Key, CapEvent[]>();
  private clock: () => number;
  /** block -> timestamp, mirroring on-chain `block.timestamp` for expiry checks (fidelity). */
  private blockTimes = new Map<bigint, number>();

  constructor(now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.clock = now;
  }

  /** Record a block's timestamp so expiry is evaluated against the block's time (not wall clock). */
  setBlockTime(block: bigint, timestamp: number): void {
    this.blockTimes.set(block, timestamp);
  }

  grant(t: CapType, granteeAgentId: bigint, resourceId: Hex, atBlock: bigint, expiry?: number): void {
    this.push(k(t, granteeAgentId, resourceId), { block: atBlock, kind: "grant", expiry: expiry ?? Number.POSITIVE_INFINITY });
  }

  revoke(t: CapType, granteeAgentId: bigint, resourceId: Hex, atBlock: bigint): void {
    this.push(k(t, granteeAgentId, resourceId), { block: atBlock, kind: "revoke", expiry: 0 });
  }

  private push(key: Key, e: CapEvent): void {
    const arr = this.events.get(key) ?? [];
    arr.push(e);
    arr.sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
    this.events.set(key, arr);
  }

  /** Reorg: drop capability events at or above `fromHeight` (orphaned). Mirrors indexer rollback. */
  reorgFrom(fromHeight: bigint): void {
    for (const [key, arr] of this.events) this.events.set(key, arr.filter((e) => e.block < fromHeight));
  }

  async hasCapability(t: CapType, granteeAgentId: bigint, resourceId: Hex, atBlock: bigint): Promise<boolean> {
    const arr = this.events.get(k(t, granteeAgentId, resourceId));
    if (!arr) return false;
    let expiry = 0; // 0 == not granted
    for (const e of arr) {
      if (e.block > atBlock) break;
      expiry = e.kind === "grant" ? e.expiry : 0;
    }
    if (expiry === 0) return false;
    // mirror on-chain `block.timestamp < expiry`: use the evaluated block's time if known, else the
    // injected clock (back-compat for tests that don't model per-block time).
    const evalTime = this.blockTimes.get(atBlock) ?? this.clock();
    return evalTime < expiry;
  }
}

/** Reads CapabilityToken.hasCapability at a specific (finalized) block via viem. */
export class OnchainCapabilityOracle implements CapabilityOracle {
  constructor(
    private readonly client: {
      readContract(args: {
        address: Hex;
        abi: readonly unknown[];
        functionName: string;
        args: readonly unknown[];
        blockNumber?: bigint;
      }): Promise<unknown>;
    },
    private readonly capabilityToken: Hex,
    private readonly abi: readonly unknown[],
  ) {}

  async hasCapability(t: CapType, granteeAgentId: bigint, resourceId: Hex, atBlock: bigint): Promise<boolean> {
    const res = await this.client.readContract({
      address: this.capabilityToken,
      abi: this.abi,
      functionName: "hasCapability",
      args: [t, granteeAgentId, resourceId],
      blockNumber: atBlock,
    });
    return res === true;
  }
}
