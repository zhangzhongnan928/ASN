"use client";

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { parseAbiItem, type Address } from "viem";
import Link from "next/link";
import { loadDeployments } from "@/lib/contracts";
import { addrUrl } from "@/lib/contracts";
import { ipfsGateway, short } from "@/lib/asn";

const PUBLISHED = parseAbiItem(
  "event Published(uint256 indexed agentId, uint256 indexed pubId, string cid, bytes32 cidDigest, bytes32 bodyHash, uint8 visibility, uint32 revision, uint32 keyEpoch, address owner)",
);

interface FeedItem {
  agentId: bigint;
  pubId: bigint;
  cid: string;
  visibility: number;
  revision: number;
  owner: Address;
  block: bigint;
}

export default function FeedPage() {
  const publicClient = usePublicClient();
  const [pubs, setPubs] = useState<Address | undefined>();
  const [items, setItems] = useState<FeedItem[]>([]);
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
        const logs = await publicClient.getLogs({ address: pubs, event: PUBLISHED, fromBlock: 0n, toBlock: "latest" });
        if (cancelled) return;
        const mapped: FeedItem[] = logs.map((l) => {
          const a = l.args as Record<string, unknown>;
          return {
            agentId: a.agentId as bigint,
            pubId: a.pubId as bigint,
            cid: a.cid as string,
            visibility: Number(a.visibility),
            revision: Number(a.revision),
            owner: a.owner as Address,
            block: l.blockNumber!,
          };
        });
        mapped.sort((x, y) => (x.block < y.block ? 1 : -1));
        setItems(mapped);
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
          Couldn&apos;t load logs from the public RPC ({error}). Set <code>NEXT_PUBLIC_RPC_URL</code> to a dedicated
          Base Sepolia RPC (e.g. Alchemy) for reliable log queries.
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
              <div className="small mono mt">
                cid:{" "}
                <a href={ipfsGateway(it.cid)} target="_blank" rel="noreferrer">
                  {it.cid}
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
