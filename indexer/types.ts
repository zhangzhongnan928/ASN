/**
 * Indexer types (spec v0.3 §8). The indexer ingests Publications events, but is NOT a raw
 * `eth_getLogs` passthrough: it tracks a block cursor, handles reorgs, validates CID+hash, and
 * serves a paginated feed.
 */
import type { Hex } from "@asn/shared";

export interface BlockRef {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
}

export type PublicationKind = "Published" | "Updated";

/** A decoded Publications event plus the off-chain-announced CID string to verify against. */
export interface PublicationEvent {
  kind: PublicationKind;
  blockNumber: bigint;
  blockHash: Hex;
  logIndex: number;
  agentId: bigint;
  pubId: bigint;
  /** Announced IPFS CID string (off-chain). Indexer verifies keccak(utf8(cid)) == cidDigest. */
  cid: string;
  cidDigest: Hex;
  bodyHash: Hex;
  revision: number;
  keyEpoch: number;
  visibility: number; // 0 public, 1 gated
  owner: Hex;
}

/** Abstract canonical chain view. A real impl reads from an RPC; the mock drives reorg scenarios. */
export interface ChainSource {
  getHead(): Promise<BlockRef>;
  /** Canonical block at `number`, or null if beyond head. */
  getBlock(number: bigint): Promise<BlockRef | null>;
  /** Canonical Publications events in [fromBlock, toBlock]. */
  getEvents(fromBlock: bigint, toBlock: bigint): Promise<PublicationEvent[]>;
}

/** Content-addressed store (IPFS abstraction) for CID/hash validation. */
export interface ContentStore {
  get(cid: string): Promise<Uint8Array | null>;
}

/** A publication as exposed by the feed (folded from validated events). */
export interface FeedItem {
  agentId: bigint;
  pubId: bigint;
  cid: string;
  cidDigest: Hex;
  bodyHash: Hex;
  revision: number;
  keyEpoch: number;
  visibility: number;
  owner: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  logIndex: number;
}
