"use client";

import { useEffect, useState } from "react";
import { useAccount, useChainId, usePublicClient, useWalletClient } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { parseAbiItem, type Abi, type Address } from "viem";
import Link from "next/link";
import { ConnectButton } from "@/components/ConnectButton";
import { AgentIDAbi, ERC6551RegistryAbi } from "@/lib/artifacts";
import { ERC6551_REGISTRY, TBA_SALT, CHAIN_ID, loadDeployments, addrUrl, txUrl, type Deployments } from "@/lib/contracts";
import { short } from "@/lib/asn";

const MINTED = parseAbiItem("event AgentMinted(uint256 indexed agentId, address indexed smartAccount)");

export default function IdentityPage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [d, setD] = useState<Deployments>({});
  const [minting, setMinting] = useState(false);
  const [mintedId, setMintedId] = useState<bigint>();
  const [hash, setHash] = useState<string>();
  const [tba, setTba] = useState<Address>();
  const [lookupId, setLookupId] = useState("");
  const [lookup, setLookup] = useState<{ owner: Address; tba: Address }>();
  const [err, setErr] = useState<string>();

  useEffect(() => setD(loadDeployments()), []);
  const wrongChain = chainId !== baseSepolia.id;
  const ready = d.agentID && d.tbaImpl;

  async function tbaOf(agentId: bigint): Promise<Address> {
    return (await publicClient!.readContract({
      address: ERC6551_REGISTRY,
      abi: ERC6551RegistryAbi as Abi,
      functionName: "account",
      args: [d.tbaImpl, TBA_SALT, BigInt(CHAIN_ID), d.agentID, agentId],
    })) as Address;
  }

  async function mint() {
    if (!walletClient || !publicClient || !d.agentID) return;
    setMinting(true);
    setErr(undefined);
    try {
      const h = await walletClient.writeContract({ address: d.agentID, abi: AgentIDAbi as Abi, functionName: "mint", args: [] } as never);
      setHash(h);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: h });
      // parse AgentMinted to get the id
      const log = receipt.logs.find((l) => l.address.toLowerCase() === d.agentID!.toLowerCase());
      let id: bigint | undefined;
      try {
        const decoded = await publicClient.getLogs({ address: d.agentID, event: MINTED, blockHash: receipt.blockHash });
        const mine = decoded.find((x) => (x.args as { smartAccount?: Address }).smartAccount?.toLowerCase() === address?.toLowerCase());
        id = (mine?.args as { agentId?: bigint })?.agentId;
      } catch {
        /* ignore */
      }
      if (id === undefined) {
        const total = (await publicClient.readContract({ address: d.agentID, abi: AgentIDAbi as Abi, functionName: "totalMinted" })) as bigint;
        id = total;
      }
      setMintedId(id);
      setTba(await tbaOf(id));
      void log;
    } catch (e) {
      setErr((e as Error).message?.slice(0, 180) ?? "mint failed");
    } finally {
      setMinting(false);
    }
  }

  async function doLookup() {
    setErr(undefined);
    setLookup(undefined);
    try {
      const id = BigInt(lookupId);
      const owner = (await publicClient!.readContract({ address: d.agentID!, abi: AgentIDAbi as Abi, functionName: "ownerOf", args: [id] })) as Address;
      setLookup({ owner, tba: await tbaOf(id) });
    } catch (e) {
      setErr("lookup failed: " + ((e as Error).message?.slice(0, 120) ?? ""));
    }
  }

  return (
    <div>
      <h1>Identity</h1>
      <p className="sub">
        Mint a permissionless AgentID. Each identity has a deterministic ERC-6551 Token Bound Account (its
        encryption identity) whose control follows ownership.
      </p>

      <div className="panel spread">
        <div className="small muted">deployer/owner: {short(address) || "—"}</div>
        <ConnectButton />
      </div>

      {!ready && (
        <div className="banner">
          No deployment configured. <Link href="/deploy">Deploy first</Link> or set the env vars.
        </div>
      )}

      {ready && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Mint your identity</h2>
          <button onClick={mint} disabled={!isConnected || wrongChain || minting}>
            {minting ? "Minting…" : "Mint AgentID (self-mint)"}
          </button>
          {hash && (
            <div className="small mt">
              <a href={txUrl(hash)} target="_blank" rel="noreferrer">tx ↗</a>
            </div>
          )}
          {mintedId !== undefined && (
            <div className="kv mt">
              <div>AgentID</div>
              <div className="mono">#{mintedId.toString()}</div>
              <div>Owner</div>
              <div className="mono">{short(address)}</div>
              <div>Token Bound Account</div>
              <div className="mono">
                <a href={addrUrl(tba!)} target="_blank" rel="noreferrer">{tba}</a>
              </div>
            </div>
          )}
        </div>
      )}

      {ready && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Look up an identity</h2>
          <div className="row">
            <input placeholder="AgentID (e.g. 1)" value={lookupId} onChange={(e) => setLookupId(e.target.value)} style={{ maxWidth: 200 }} />
            <button className="ghost" onClick={doLookup} disabled={!lookupId}>Look up</button>
          </div>
          {lookup && (
            <div className="kv mt">
              <div>Owner</div>
              <div className="mono"><a href={addrUrl(lookup.owner)} target="_blank" rel="noreferrer">{lookup.owner}</a></div>
              <div>Token Bound Account</div>
              <div className="mono"><a href={addrUrl(lookup.tba)} target="_blank" rel="noreferrer">{lookup.tba}</a></div>
            </div>
          )}
        </div>
      )}

      {err && <div className="banner">{err}</div>}
    </div>
  );
}
