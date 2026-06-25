/**
 * Independent feed API over the indexer (spec v0.3 §8: "独立 feed API"). Cursor-based pagination
 * that is stable across reorgs (cursor is content/position based, not an array index).
 * This same API backs both the human read-only web feed and the MCP `feed_read` tool.
 */
import type { FeedItem } from "./types.js";
import { Indexer, cmpDesc } from "./indexer.js";

export interface FeedPage {
  items: FeedItem[];
  nextCursor: string | null;
}

/** Encode/decode an opaque cursor for an item's position in the latest-first ordering. */
function cursorOf(i: FeedItem): string {
  return `${i.blockNumber}:${i.logIndex}:${i.agentId}:${i.pubId}`;
}
function afterCursor(items: FeedItem[], cursor: string): FeedItem[] {
  const idx = items.findIndex((i) => cursorOf(i) === cursor);
  return idx < 0 ? items : items.slice(idx + 1);
}

export class FeedApi {
  constructor(private readonly indexer: Indexer) {}

  /** Latest-first page. `before` continues after a prior page's nextCursor. */
  getFeed(opts: { limit?: number; before?: string; agentId?: bigint } = {}): FeedPage {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    let items = this.indexer.allItems().sort(cmpDesc);
    if (opts.agentId !== undefined) items = items.filter((i) => i.agentId === opts.agentId);
    if (opts.before) items = afterCursor(items, opts.before);
    const page = items.slice(0, limit);
    const nextCursor = items.length > limit && page.length > 0 ? cursorOf(page[page.length - 1]!) : null;
    return { items: page, nextCursor };
  }

  getPublication(agentId: bigint, pubId: bigint): FeedItem | null {
    return this.indexer.getPublication(agentId, pubId);
  }
}
