/**
 * ASN Indexer (spec v0.3 §8). Responsibilities:
 *   - block cursor + confirmations
 *   - reorg handling (common-ancestor walk, rollback of orphaned events)
 *   - CID + hash validation (never index a forged / unverifiable entry)
 *   - a folded, paginated feed (consistent across reorgs: no ghosts, no gaps)
 */
import { keccak256, utf8, type Hex } from "@asn/shared";
import { computeCID, bodyHash as hashBody, cidDigest as digestOfCid } from "@asn/encryption";
import type { BlockRef, ChainSource, ContentStore, FeedItem, PublicationEvent } from "./types.js";

export interface IndexerOptions {
  confirmations?: number;
}

export class Indexer {
  private cursor = 0n; // highest indexed block number (0 = only genesis)
  private blockHashes = new Map<bigint, Hex>(); // indexed height -> hash (reorg detection)
  private accepted: PublicationEvent[] = []; // validated events, in arrival order
  private readonly confirmations: bigint;

  constructor(
    private readonly source: ChainSource,
    private readonly content: ContentStore,
    opts: IndexerOptions = {},
  ) {
    this.confirmations = BigInt(opts.confirmations ?? 0);
  }

  get headCursor(): bigint {
    return this.cursor;
  }

  /** Validate one event against the content store: announced cid binds to on-chain digest, content
   *  hashes to bodyHash, and content re-CIDs to the announced cid. Any mismatch => reject. */
  private async validate(e: PublicationEvent): Promise<boolean> {
    if (digestOfCid(e.cid) !== e.cidDigest) return false; // announced cid must match on-chain digest
    const bytes = await this.content.get(e.cid);
    if (!bytes) return false; // unavailable content cannot be verified -> not indexed
    if (hashBody(bytes) !== e.bodyHash) return false; // body integrity
    const reCid = await computeCID(bytes);
    if (reCid !== e.cid) return false; // content actually matches the CID
    return true;
  }

  /** Find the highest indexed height that still matches the source's canonical chain. */
  private async commonAncestor(maxHeight: bigint): Promise<bigint> {
    let h = maxHeight;
    while (h > 0n) {
      const stored = this.blockHashes.get(h);
      const canonical = await this.source.getBlock(h);
      if (stored !== undefined && canonical && stored === canonical.hash) return h;
      h -= 1n;
    }
    return 0n; // back to genesis
  }

  /** Pull new/canonical events, rolling back any orphaned blocks first. */
  async sync(): Promise<void> {
    const head: BlockRef = await this.source.getHead();
    const safeHead = head.number > this.confirmations ? head.number - this.confirmations : 0n;

    // Detect reorg: does our current cursor still sit on the canonical chain?
    const checkFrom = this.cursor < head.number ? this.cursor : head.number;
    const ancestor = await this.commonAncestor(checkFrom);
    if (ancestor < this.cursor) {
      // rollback orphaned events + hashes
      this.accepted = this.accepted.filter((e) => e.blockNumber <= ancestor);
      for (const h of [...this.blockHashes.keys()]) if (h > ancestor) this.blockHashes.delete(h);
      this.cursor = ancestor;
    }

    // Index forward to safeHead.
    if (safeHead <= this.cursor) return;
    const events = await this.source.getEvents(this.cursor + 1n, safeHead);
    // record canonical block hashes for the newly indexed range (so future reorgs are detectable)
    for (let h = this.cursor + 1n; h <= safeHead; h++) {
      const blk = await this.source.getBlock(h);
      if (blk) this.blockHashes.set(h, blk.hash);
    }
    // sort events deterministically before validation/append
    events.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber)));
    for (const e of events) {
      if (e.blockNumber > safeHead) continue;
      // reject any event whose blockHash does not match the canonical hash for that height — closes
      // an orphan-admit race where the RPC returns logs from a block that is no longer canonical.
      if (e.blockHash !== this.blockHashes.get(e.blockNumber)) continue;
      if (await this.validate(e)) this.accepted.push(e);
    }
    this.cursor = safeHead;
  }

  /** Fold accepted events into the current feed state, keyed by (agentId, pubId). */
  private foldFeed(): Map<string, FeedItem> {
    const sorted = [...this.accepted].sort((a, b) =>
      a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber),
    );
    const feed = new Map<string, FeedItem>();
    for (const e of sorted) {
      const key = `${e.agentId}:${e.pubId}`;
      const prev = feed.get(key);
      const item: FeedItem = {
        agentId: e.agentId,
        pubId: e.pubId,
        cid: e.cid,
        cidDigest: e.cidDigest,
        bodyHash: e.bodyHash,
        revision: e.revision,
        keyEpoch: e.keyEpoch,
        visibility: prev && e.kind === "Updated" ? prev.visibility : e.visibility,
        owner: prev && e.kind === "Updated" ? prev.owner : e.owner,
        blockNumber: e.blockNumber,
        blockHash: e.blockHash,
        logIndex: e.logIndex,
      };
      feed.set(key, item);
    }
    return feed;
  }

  /** All current feed items (latest-active first). */
  allItems(): FeedItem[] {
    return [...this.foldFeed().values()].sort(cmpDesc);
  }

  getPublication(agentId: bigint, pubId: bigint): FeedItem | null {
    return this.foldFeed().get(`${agentId}:${pubId}`) ?? null;
  }
}

/** latest-first ordering: by blockNumber desc, then logIndex desc, then key desc (stable). */
export function cmpDesc(a: FeedItem, b: FeedItem): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? 1 : -1;
  if (a.logIndex !== b.logIndex) return b.logIndex - a.logIndex;
  if (a.agentId !== b.agentId) return a.agentId < b.agentId ? 1 : -1;
  return a.pubId < b.pubId ? 1 : a.pubId > b.pubId ? -1 : 0;
}

export { keccak256, utf8 };
