"use client";

import { useMemo, useState } from "react";
import { useAccount, useChainId, usePublicClient, useWalletClient } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { concat, encodeDeployData, getContractAddress, toHex, type Abi, type Address, type Hex } from "viem";
import { ConnectButton } from "@/components/ConnectButton";
import {
  AgentIDAbi,
  AgentIDBytecode,
  CapabilityTokenAbi,
  CapabilityTokenBytecode,
  PublicationsAbi,
  PublicationsBytecode,
  ASNTokenBoundAccountAbi,
  ASNTokenBoundAccountBytecode,
  TBAKeyRegistryAbi,
  TBAKeyRegistryBytecode,
  ASNPaymasterAbi,
  ASNPaymasterBytecode,
} from "@/lib/artifacts";
import { CREATE2_DEPLOYER, ENTRYPOINT_V06, saveDeployments, txUrl, addrUrl, type Deployments } from "@/lib/contracts";
import { short } from "@/lib/asn";

type StepStatus = "idle" | "pending" | "done" | "error";
interface StepState {
  status: StepStatus;
  hash?: Hex;
  address?: Address;
  error?: string;
}
const STEP_KEYS = ["agentID", "capabilityToken", "publications", "tbaImpl", "tbaKeyRegistry", "paymaster", "wire"] as const;
type StepKey = (typeof STEP_KEYS)[number];
const LABELS: Record<StepKey, string> = {
  agentID: "Deploy AgentID (ERC-721 identity)",
  capabilityToken: "Deploy CapabilityToken (VIEW capabilities)",
  publications: "Deploy Publications (commitment anchor)",
  tbaImpl: "Deploy ASNTokenBoundAccount (ERC-6551 impl)",
  tbaKeyRegistry: "Deploy TBAKeyRegistry (encryption keys)",
  paymaster: "Deploy ASNPaymaster (ERC-4337 v0.6)",
  wire: "Wire CapabilityToken → Publications (setPublications)",
};

function randomSalt(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return toHex(b);
}

export default function DeployPage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const [salt] = useState<Hex>(() => randomSalt());
  const [addrs, setAddrs] = useState<Deployments>({});
  const [steps, setSteps] = useState<Record<StepKey, StepState>>(
    () => Object.fromEntries(STEP_KEYS.map((k) => [k, { status: "idle" }])) as Record<StepKey, StepState>,
  );
  const [running, setRunning] = useState(false);

  const wrongChain = chainId !== baseSepolia.id;
  const firstPending = STEP_KEYS.find((k) => steps[k].status !== "done");
  const allDone = !firstPending;
  const setStep = (k: StepKey, s: Partial<StepState>) => setSteps((prev) => ({ ...prev, [k]: { ...prev[k], ...s } }));

  /** Build initcode + deterministic CREATE2 address for a contract. */
  function plan(abi: Abi, bytecode: Hex, args: unknown[]): { initcode: Hex; address: Address } {
    const initcode = encodeDeployData({ abi, bytecode, args } as never) as Hex;
    const address = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt, bytecode: initcode });
    return { initcode, address };
  }

  /** All addresses are deterministic from (salt, user); compute them upfront. */
  function computeAll(user: Address) {
    const agentID = plan(AgentIDAbi as Abi, AgentIDBytecode as Hex, ["ipfs://asn/agent/"]);
    const capabilityToken = plan(CapabilityTokenAbi as Abi, CapabilityTokenBytecode as Hex, [agentID.address, user]);
    const publications = plan(PublicationsAbi as Abi, PublicationsBytecode as Hex, [agentID.address, capabilityToken.address]);
    const tbaImpl = plan(ASNTokenBoundAccountAbi as Abi, ASNTokenBoundAccountBytecode as Hex, []);
    const tbaKeyRegistry = plan(TBAKeyRegistryAbi as Abi, TBAKeyRegistryBytecode as Hex, []);
    const paymaster = plan(ASNPaymasterAbi as Abi, ASNPaymasterBytecode as Hex, [ENTRYPOINT_V06, user]);
    return { agentID, capabilityToken, publications, tbaImpl, tbaKeyRegistry, paymaster };
  }

  /** Deploy one contract via the CREATE2 factory (a normal CALL — works for any account type). */
  async function deployVia(initcode: Hex, expected: Address): Promise<Hex> {
    if (!walletClient || !publicClient) throw new Error("wallet not ready");
    const existing = await publicClient.getCode({ address: expected });
    if (existing && existing !== "0x") return "0x_already" as Hex; // idempotent
    const hash = await walletClient.sendTransaction({ to: CREATE2_DEPLOYER, data: concat([salt, initcode]) });
    await publicClient.waitForTransactionReceipt({ hash });
    const code = await publicClient.getCode({ address: expected });
    if (!code || code === "0x") throw new Error("deployment produced no code at the expected address");
    return hash;
  }

  async function runStep(k: StepKey, acc: Deployments, plans: ReturnType<typeof computeAll>): Promise<Deployments> {
    setStep(k, { status: "pending", error: undefined });
    try {
      if (k === "wire") {
        if (!walletClient || !publicClient) throw new Error("wallet not ready");
        const hash = await walletClient.writeContract({
          address: acc.capabilityToken!,
          abi: CapabilityTokenAbi as Abi,
          functionName: "setPublications",
          args: [acc.publications],
        } as never);
        await publicClient.waitForTransactionReceipt({ hash });
        setStep(k, { status: "done", hash });
        return acc;
      }
      const p = plans[k as keyof ReturnType<typeof computeAll>];
      const hash = await deployVia(p.initcode, p.address);
      setStep(k, { status: "done", hash: hash === "0x_already" ? undefined : hash, address: p.address });
      const key = k as keyof Deployments;
      return { ...acc, [key]: p.address };
    } catch (e) {
      setStep(k, { status: "error", error: (e as Error).message?.slice(0, 200) ?? "failed" });
      throw e;
    }
  }

  async function runAll() {
    if (!isConnected || wrongChain || !address) return;
    setRunning(true);
    const plans = computeAll(address);
    let acc: Deployments = { ...addrs };
    try {
      for (const k of STEP_KEYS) {
        if (steps[k].status === "done") continue;
        acc = await runStep(k, acc, plans);
        setAddrs(acc);
        saveDeployments(acc);
      }
    } catch {
      /* stop at the failing step; user can fix + resume */
    } finally {
      setRunning(false);
    }
  }

  const envBlock = useMemo(() => {
    const e = (k: string, v?: string) => (v ? `${k}=${v}` : `# ${k}=<deploy first>`);
    return [
      e("NEXT_PUBLIC_AGENTID", addrs.agentID),
      e("NEXT_PUBLIC_CAPABILITY_TOKEN", addrs.capabilityToken),
      e("NEXT_PUBLIC_PUBLICATIONS", addrs.publications),
      e("NEXT_PUBLIC_TBA_IMPL", addrs.tbaImpl),
      e("NEXT_PUBLIC_TBA_KEY_REGISTRY", addrs.tbaKeyRegistry),
      e("NEXT_PUBLIC_PAYMASTER", addrs.paymaster),
    ].join("\n");
  }, [addrs]);

  function downloadJson() {
    const blob = new Blob([JSON.stringify({ chainId: 84532, owner: address, ...addrs }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "asn-deployments.baseSepolia.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <h1>One-time deploy</h1>
      <p className="sub">
        Connect any wallet (EOA, EIP-7702, or smart wallet) and sign each transaction to deploy the ASN
        contracts to Base Sepolia via the deterministic CREATE2 factory. Your address becomes the
        ASNPaymaster owner + CapabilityToken admin. ~7 transactions, ~0.0001 test ETH total.
      </p>

      <div className="panel spread">
        <div className="small muted">Base Sepolia (84532) · deployer: {short(address) || "—"}</div>
        <ConnectButton />
      </div>

      {!isConnected && <div className="banner">Connect a wallet and fund it from a Base Sepolia faucet (~0.001 test ETH).</div>}
      {isConnected && wrongChain && <div className="banner">Wrong network — switch to Base Sepolia.</div>}

      <div className="panel">
        {STEP_KEYS.map((k, i) => {
          const s = steps[k];
          const active = firstPending === k;
          return (
            <div key={k} className={`step ${s.status === "done" ? "done" : active ? "active" : ""}`}>
              <div className="idx">{s.status === "done" ? "✓" : i + 1}</div>
              <div className="body">
                <div className="spread">
                  <span className="name">{LABELS[k]}</span>
                  <span className={`pill ${s.status === "error" ? "err" : s.status === "done" ? "ok" : ""}`}>{s.status}</span>
                </div>
                {s.address && (
                  <div className="small mono mt">
                    <a href={addrUrl(s.address)} target="_blank" rel="noreferrer">{s.address}</a>
                  </div>
                )}
                {s.hash && (
                  <div className="small mt">
                    <a href={txUrl(s.hash)} target="_blank" rel="noreferrer">tx ↗</a>
                  </div>
                )}
                {s.error && <div className="small" style={{ color: "var(--err)" }}>{s.error}</div>}
              </div>
            </div>
          );
        })}

        <div className="row mt">
          <button onClick={runAll} disabled={!isConnected || wrongChain || running || allDone}>
            {running ? "Deploying…" : allDone ? "All deployed ✓" : firstPending && steps[firstPending].status === "error" ? "Resume deploy" : "Deploy all"}
          </button>
          {allDone && (
            <button className="ghost" onClick={downloadJson}>Download deployments.json</button>
          )}
        </div>
      </div>

      {(allDone || addrs.agentID) && (
        <>
          <h2>Set these in Vercel (Environment Variables)</h2>
          <p className="small muted">Add these to your Vercel project and redeploy so the hosted app points at your deployment.</p>
          <div className="code-block">{envBlock}</div>
        </>
      )}
    </div>
  );
}
