"use client";

import { useEffect, useState } from "react";
import { useAccount, useChainId, usePublicClient, useWalletClient } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import type { Abi } from "viem";
import Link from "next/link";
import { ConnectButton } from "@/components/ConnectButton";
import { AgentIDAbi, PublicationsAbi } from "@/lib/artifacts";
import { loadDeployments, txUrl, type Deployments } from "@/lib/contracts";
import { bodyHash, textToBytes, pinText } from "@/lib/asn";

export default function PublishPage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [d, setD] = useState<Deployments>({});
  const [agentId, setAgentId] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [hash, setHash] = useState<string>();
  const [cid, setCid] = useState<string>();
  const [pinned, setPinned] = useState(false);
  const [err, setErr] = useState<string>();

  useEffect(() => setD(loadDeployments()), []);
  const wrongChain = chainId !== baseSepolia.id;

  async function publish() {
    if (!walletClient || !publicClient || !d.publications || !d.agentID) return;
    setBusy(true);
    setErr(undefined);
    setHash(undefined);
    try {
      const id = BigInt(agentId);
      // ownership guard (friendly error before the tx reverts)
      const owner = (await publicClient.readContract({ address: d.agentID, abi: AgentIDAbi as Abi, functionName: "ownerOf", args: [id] })) as string;
      if (owner.toLowerCase() !== address?.toLowerCase()) {
        throw new Error(`You don't own AgentID #${agentId} (owner is ${owner})`);
      }
      const bh = bodyHash(textToBytes(text));
      // pin to IPFS (server-side, if configured); fall back to a local CID otherwise.
      const { cid: c, pinned: didPin } = await pinText(text);
      setCid(c);
      setPinned(didPin);
      // cache locally too (instant display + offline fallback).
      try {
        window.localStorage.setItem(`asn.content.${c}`, text);
      } catch {
        /* ignore */
      }
      const h = await walletClient.writeContract({
        address: d.publications,
        abi: PublicationsAbi as Abi,
        functionName: "publish",
        args: [id, c, bh, 0], // visibility 0 = public
      } as never);
      setHash(h);
      await publicClient.waitForTransactionReceipt({ hash: h });
    } catch (e) {
      setErr((e as Error).message?.slice(0, 220) ?? "publish failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Publish</h1>
      <p className="sub">Anchor a public post on-chain. The body is content-addressed (CID + keccak hash).</p>

      <div className="panel spread">
        <div className="small muted">author: {address ? address.slice(0, 10) + "…" : "—"}</div>
        <ConnectButton />
      </div>

      {!d.publications && (
        <div className="banner">
          No deployment configured. <Link href="/deploy">Deploy first</Link> or set the env vars.
        </div>
      )}

      <div className="panel">
        <label>Your AgentID</label>
        <input placeholder="e.g. 1 — mint one on the Identity page" value={agentId} onChange={(e) => setAgentId(e.target.value)} style={{ maxWidth: 220 }} />
        <label>Post content</label>
        <textarea placeholder="Say something…" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row mt">
          <button onClick={publish} disabled={!isConnected || wrongChain || busy || !agentId || !text || !d.publications}>
            {busy ? "Publishing…" : "Publish (public)"}
          </button>
        </div>
        {cid && (
          <div className="small mono mt">
            cid: {cid} {pinned ? <span className="pill ok">pinned to IPFS</span> : <span className="pill warn">local only (set PINATA_JWT)</span>}
          </div>
        )}
        {hash && (
          <div className="small mt">
            <a href={txUrl(hash)} target="_blank" rel="noreferrer">tx ↗</a> — your post is on the <Link href="/">feed</Link>.
          </div>
        )}
        {err && <div className="banner mt">{err}</div>}
      </div>

      <div className="panel small muted">
        When <code>PINATA_JWT</code> is set (server-side env var), post bodies are pinned to IPFS and resolve
        for everyone. Otherwise the commitment is anchored on-chain and the body is kept in your browser.
        Gated/encrypted posts require the off-chain TBA key service and are not exposed in this demo UI.
      </div>
    </div>
  );
}
