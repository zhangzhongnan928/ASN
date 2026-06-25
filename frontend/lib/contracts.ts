import type { Address } from "viem";
import {
  AgentIDAbi,
  CapabilityTokenAbi,
  PublicationsAbi,
  ASNTokenBoundAccountAbi,
  TBAKeyRegistryAbi,
  ASNPaymasterAbi,
  ERC6551RegistryAbi,
} from "./artifacts";

export const CHAIN_ID = 84532; // Base Sepolia
export const ENTRYPOINT_V06: Address = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";
export const ERC6551_REGISTRY: Address = "0x000000006551c19487814612e58FE06813775758";
export const COINBASE_FACTORY: Address = "0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a";
export const TBA_SALT = ("0x" + "00".repeat(32)) as `0x${string}`;
/** Canonical deterministic CREATE2 deployer (Arachnid), present on Base Sepolia. Used so the deploy
 *  works from any account type (EOA, EIP-7702 EOA, or smart wallet) via a normal CALL. */
export const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

export const abis = {
  AgentID: AgentIDAbi,
  CapabilityToken: CapabilityTokenAbi,
  Publications: PublicationsAbi,
  ASNTokenBoundAccount: ASNTokenBoundAccountAbi,
  TBAKeyRegistry: TBAKeyRegistryAbi,
  ASNPaymaster: ASNPaymasterAbi,
  ERC6551Registry: ERC6551RegistryAbi,
} as const;

export interface Deployments {
  agentID?: Address;
  capabilityToken?: Address;
  publications?: Address;
  tbaImpl?: Address;
  tbaKeyRegistry?: Address;
  paymaster?: Address;
}

const LS_KEY = "asn.deployments.baseSepolia";

const envAddr = (v: string | undefined): Address | undefined =>
  v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : undefined;

/** Deployed addresses: env (NEXT_PUBLIC_*) first, then localStorage saved by the deploy dApp. */
export function loadDeployments(): Deployments {
  const fromEnv: Deployments = {
    agentID: envAddr(process.env.NEXT_PUBLIC_AGENTID),
    capabilityToken: envAddr(process.env.NEXT_PUBLIC_CAPABILITY_TOKEN),
    publications: envAddr(process.env.NEXT_PUBLIC_PUBLICATIONS),
    tbaImpl: envAddr(process.env.NEXT_PUBLIC_TBA_IMPL),
    tbaKeyRegistry: envAddr(process.env.NEXT_PUBLIC_TBA_KEY_REGISTRY),
    paymaster: envAddr(process.env.NEXT_PUBLIC_PAYMASTER),
  };
  let fromLS: Deployments = {};
  if (typeof window !== "undefined") {
    try {
      fromLS = JSON.parse(window.localStorage.getItem(LS_KEY) || "{}");
    } catch {
      fromLS = {};
    }
  }
  return { ...fromLS, ...prune(fromEnv) };
}

export function saveDeployments(d: Deployments): void {
  if (typeof window === "undefined") return;
  const cur = loadDeployments();
  window.localStorage.setItem(LS_KEY, JSON.stringify({ ...cur, ...prune(d) }));
}

function prune(d: Deployments): Deployments {
  return Object.fromEntries(Object.entries(d).filter(([, v]) => !!v)) as Deployments;
}

export const BASESCAN = "https://sepolia.basescan.org";
export const txUrl = (h: string) => `${BASESCAN}/tx/${h}`;
export const addrUrl = (a: string) => `${BASESCAN}/address/${a}`;
