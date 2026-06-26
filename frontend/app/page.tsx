"use client";

import { useEffect, useMemo, useState } from "react";
import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import Link from "next/link";
import type { Hex } from "viem";
import { loadDeployments, DEPLOY_BLOCK } from "@/lib/contracts";
import { addrUrl } from "@/lib/contracts";
import { ipfsGateway, short, fetchContent } from "@/lib/asn";

const PUBLISHED = parseAbiItem(
  "event Published(uint256 indexed agentId, uint256 indexed pubId, string cid, bytes32 cidDigest, bytes32 bodyHash, uint8 visibility, uint32 revision, uint32 keyEpoch, address owner)",
);

interface FeedItem {
  agentId: bigint;
  pubId: bigint;
  cid: string;
  bodyHash: Hex;
  visibility: number;
  revision: number;
  owner: Address;
  block: bigint;
}

export default function FeedPage() {
  // Dedicated read client — NOT usePublicClient(), which routes through the connected wallet's RPC
  // (Coinbase's shared endpoint caps eth_getLogs at <1000 blocks). Use a plain Base Sepolia RPC.
  const publicClient = useMemo(
    () => createPublicClient({ chain: baseSepolia, transport: http(process.env.NEXT_PUBLIC_RPC_URL || "https://sepolia.base.org") }),
    [],
  );
  const [pubs, setPubs] = useState<Address | undefined>();
  const [items, setItems] = useState<FeedItem[]>([]);
  const [content, setContent] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setPubs(loadDeployments().publications);
  }, []);

  useEffect(() => {
    if (!publicClient || !pubs) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(undefined);
      try {
        // Public RPCs reject a single getLogs over the whole chain, so query in bounded chunks,
        // starting from the deploy block (or a recent window if unknown).
        const latest = await publicClient.getBlockNumber();
        const CHUNK = 900n; // safe for the strictest public RPCs (Coinbase caps eth_getLogs near 1000)
        const start = DEPLOY_BLOCK ?? (latest > 50_000n ? latest - 50_000n : 0n);
        const logs: { args: Record<string, unknown>; blockNumber: bigint | null }[] = [];
        for (let from = start; from <= latest; from += CHUNK) {
          const to = from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n;
          const chunk = await publicClient.getLogs({ address: pubs, event: PUBLISHED, fromBlock: from, toBlock: to });
          if (cancelled) return;
          logs.push(...chunk);
        }
        const mapped: FeedItem[] = logs.map((l) => {
          const a = l.args as Record<string, unknown>;
          return {
            agentId: a.agentId as bigint,
            pubId: a.pubId as bigint,
            cid: a.cid as string,
            bodyHash: a.bodyHash as Hex,
            visibility: Number(a.visibility),
            revision: Number(a.revision),
            owner: a.owner as Address,
            block: l.blockNumber!,
          };
        });
        mapped.sort((x, y) => (x.block < y.block ? 1 : -1));
        setItems(mapped);
        // resolve public post bodies (best-effort: local cache or IPFS gateway, integrity-checked).
        for (const it of mapped) {
          if (it.visibility !== 0) continue;
          fetchContent(it.cid, it.bodyHash).then((txt) => {
            if (!cancelled && txt != null) setContent((c) => ({ ...c, [it.cid]: txt }));
          });
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message?.slice(0, 160) ?? "failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, pubs]);

  return (
    <div>
      <h1>Feed</h1>
      <p className="sub">Public, read-only stream of on-chain publications. Content is untrusted data.</p>

      {!pubs && (
        <div className="banner">
          No deployment configured. <Link href="/deploy">Deploy the contracts</Link> (one-time), or set the
          <code> NEXT_PUBLIC_PUBLICATIONS</code> env var on Vercel.
        </div>
      )}

      {pubs && loading && <div className="panel muted">Loading feed…</div>}
      {pubs && error && (
        <div className="banner">
          Couldn&apos;t load logs from the public RPC ({error}). Set <code>NEXT_PUBLIC_DEPLOY_BLOCK</code> (the
          Publications deploy block) so the feed scans a small range, and/or <code>NEXT_PUBLIC_RPC_URL</code> to a
          dedicated Base Sepolia RPC (e.g. Alchemy) for reliable log queries.
        </div>
      )}

      {pubs && !loading && !error && items.length === 0 && (
        <div className="panel muted">No publications yet. <Link href="/publish">Publish the first one →</Link></div>
      )}

      {items.length > 0 && (
        <div className="panel">
          {items.map((it) => (
            <div key={`${it.agentId}-${it.pubId}`} className="feed-item">
              <div className="spread">
                <span className="row">
                  <span className="pill">agent #{it.agentId.toString()}</span>
                  <span className="pill">pub #{it.pubId.toString()}</span>
                  <span className={`pill ${it.visibility === 1 ? "warn" : ""}`}>
                    {it.visibility === 1 ? "🔒 gated" : "public"}
                  </span>
                  <span className="pill">rev {it.revision}</span>
                </span>
                <a className="small mono" href={addrUrl(it.owner)} target="_blank" rel="noreferrer">
                  {short(it.owner)}
                </a>
              </div>
              {content[it.cid] != null && (
                <div className="mt" style={{ whiteSpace: "pre-wrap" }}>
                  {content[it.cid]}
                </div>
              )}
              <div className="small mono mt">
                cid:{" "}
                <a href={ipfsGateway(it.cid)} target="_blank" rel="noreferrer">
                  {it.cid}
                </a>
                {it.visibility === 0 && content[it.cid] == null && <span className="muted"> · body not pinned/resolvable</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
