/**
 * Deterministic mock chain + content store for driving reorg scenarios (AT-8) offline.
 * Blocks are an ordered list; `reorg(depth, ...)` rewrites the tail to a different sequence,
 * exactly modelling a chain reorganization.
 */
import { keccak256, toHex, utf8, type Hex } from "@asn/shared";
import type { BlockRef, ChainSource, ContentStore, PublicationEvent } from "./types.js";

interface MockBlock {
  ref: BlockRef;
  events: PublicationEvent[];
}

function hashBlock(number: bigint, parentHash: Hex, nonce: string): Hex {
  return keccak256(utf8(`${number}:${parentHash}:${nonce}`));
}

export class MockChainSource implements ChainSource {
  private blocks: MockBlock[] = [];

  constructor() {
    // genesis
    const genesisHash = keccak256(utf8("genesis"));
    this.blocks.push({
      ref: { number: 0n, hash: genesisHash, parentHash: ("0x" + "00".repeat(32)) as Hex },
      events: [],
    });
  }

  /** Append a block carrying `events` (their block fields are stamped here). `nonce` varies the hash
   *  so two chains can differ at the same height (used by reorg). */
  addBlock(events: Omit<PublicationEvent, "blockNumber" | "blockHash" | "logIndex">[], nonce = "a"): BlockRef {
    const parent = this.blocks[this.blocks.length - 1]!;
    const number = parent.ref.number + 1n;
    const hash = hashBlock(number, parent.ref.hash, nonce);
    const stamped: PublicationEvent[] = events.map((e, i) => ({
      ...e,
      blockNumber: number,
      blockHash: hash,
      logIndex: i,
    }));
    const ref: BlockRef = { number, hash, parentHash: parent.ref.hash };
    this.blocks.push({ ref, events: stamped });
    return ref;
  }

  /** Reorg: drop the last `depth` blocks and replace with `replacement` chains (each a list of
   *  events for one new block). The new blocks get a different nonce, so their hashes differ. */
  reorg(depth: number, replacement: Array<Omit<PublicationEvent, "blockNumber" | "blockHash" | "logIndex">[]>): void {
    if (depth >= this.blocks.length) throw new Error("reorg depth exceeds chain");
    this.blocks = this.blocks.slice(0, this.blocks.length - depth);
    let nonceCounter = 0;
    for (const evs of replacement) this.addBlock(evs, `reorg-${nonceCounter++}`);
  }

  async getHead(): Promise<BlockRef> {
    return this.blocks[this.blocks.length - 1]!.ref;
  }

  async getBlock(number: bigint): Promise<BlockRef | null> {
    const b = this.blocks.find((x) => x.ref.number === number);
    return b ? b.ref : null;
  }

  async getEvents(fromBlock: bigint, toBlock: bigint): Promise<PublicationEvent[]> {
    const out: PublicationEvent[] = [];
    for (const b of this.blocks) {
      if (b.ref.number >= fromBlock && b.ref.number <= toBlock) out.push(...b.events);
    }
    return out;
  }

  // helpers for tests
  headNumber(): bigint {
    return this.blocks[this.blocks.length - 1]!.ref.number;
  }
}

export class InMemoryContentStore implements ContentStore {
  private store = new Map<string, Uint8Array>();
  put(cid: string, bytes: Uint8Array): void {
    this.store.set(cid, bytes);
  }
  async get(cid: string): Promise<Uint8Array | null> {
    return this.store.get(cid) ?? null;
  }
}

export { toHex };
