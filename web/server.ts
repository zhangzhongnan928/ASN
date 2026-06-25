/**
 * Human read-only web feed (spec v0.3 §12.1 M0 component; §1 "人也能用"). A minimal HTTP server over
 * the same independent feed API the MCP `feed_read` tool uses. Read-only: it never writes on-chain
 * and never executes any content/script. Content is rendered as untrusted data.
 */
import { createServer, type Server } from "node:http";
import type { FeedApi, FeedItem } from "@asn/indexer";

function itemJson(i: FeedItem) {
  return {
    agentId: i.agentId.toString(),
    pubId: i.pubId.toString(),
    cid: i.cid,
    revision: i.revision,
    keyEpoch: i.keyEpoch,
    visibility: i.visibility === 1 ? "capability_gated" : "public",
    owner: i.owner,
    blockNumber: i.blockNumber.toString(),
  };
}

function page(items: FeedItem[]): string {
  const rows = items
    .map(
      (i) =>
        `<li><b>agent ${i.agentId.toString()}</b> · pub ${i.pubId.toString()} · rev ${i.revision} · ${
          i.visibility === 1 ? "🔒 gated" : "public"
        } · <code>${i.cid}</code></li>`,
    )
    .join("\n");
  // NOTE: content bodies are NOT rendered as HTML here; the feed is read-only and treats all
  // off-chain content as untrusted data.
  return `<!doctype html><html><head><meta charset="utf-8"><title>ASN feed</title></head>
<body><h1>ASN — read-only feed</h1><ul>${rows}</ul></body></html>`;
}

export function createFeedServer(feed: FeedApi): Server {
  return createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method !== "GET") {
        res.writeHead(405).end("read-only");
        return;
      }
      if (url.pathname === "/feed") {
        const limit = Number(url.searchParams.get("limit") ?? "50");
        const before = url.searchParams.get("before") ?? undefined;
        const agentParam = url.searchParams.get("agentId");
        const opts: { limit: number; before?: string; agentId?: bigint } = { limit };
        if (before) opts.before = before;
        if (agentParam) opts.agentId = BigInt(agentParam);
        const p = feed.getFeed(opts);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ items: p.items.map(itemJson), nextCursor: p.nextCursor }));
        return;
      }
      const m = url.pathname.match(/^\/pub\/(\d+)\/(\d+)$/);
      if (m) {
        const it = feed.getPublication(BigInt(m[1]!), BigInt(m[2]!));
        if (!it) {
          res.writeHead(404).end(JSON.stringify({ error: "not found" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(itemJson(it)));
        return;
      }
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(page(feed.getFeed({ limit: 50 }).items));
        return;
      }
      res.writeHead(404).end("not found");
    } catch (e) {
      res.writeHead(500).end(JSON.stringify({ error: (e as Error).message }));
    }
  });
}
