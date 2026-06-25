/**
 * Coinbase Smart Wallet integration (spec v0.3 §3, /account). Off-chain SDK to deploy and drive a
 * Coinbase Smart Wallet (ERC-4337 v0.6) for an agent identity. Key management (rotation, recovery,
 * multisig) is the smart account's job (§3.1) — we deliberately do not implement signerOf.
 *
 * Two execution modes for ASN writes (publish/grant/revoke), both routed through the smart account so
 * the wallet is always `msg.sender` to ASN contracts:
 *   - owner-direct: an owner EOA calls `wallet.execute(target, 0, data)` (CBSW allows owner callers).
 *   - sponsored / self-pay: a UserOp via the EntryPoint (see paymaster/ for the gas strategy).
 */
import {
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const ENTRYPOINT_V06: Address = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";
/** Canonical CoinbaseSmartWalletFactory on Base mainnet & Base Sepolia. */
export const COINBASE_FACTORY_BASE: Address = "0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a";

// Minimal ABIs (only what we call).
const FACTORY_ABI = [
  { type: "function", name: "createAccount", stateMutability: "payable", inputs: [{ name: "owners", type: "bytes[]" }, { name: "nonce", type: "uint256" }], outputs: [{ name: "account", type: "address" }] },
  { type: "function", name: "getAddress", stateMutability: "view", inputs: [{ name: "owners", type: "bytes[]" }, { name: "nonce", type: "uint256" }], outputs: [{ type: "address" }] },
] as const satisfies Abi;

const WALLET_ABI = [
  { type: "function", name: "execute", stateMutability: "payable", inputs: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }], outputs: [] },
] as const satisfies Abi;

export interface WalletClientConfig {
  rpcUrl: string;
  chain: Chain;
  publicClient: PublicClient;
  factory?: Address;
}

/** Owner-controlled Coinbase Smart Wallet handle. */
export class CoinbaseSmartWalletClient {
  readonly factory: Address;
  constructor(private readonly cfg: WalletClientConfig) {
    this.factory = cfg.factory ?? COINBASE_FACTORY_BASE;
  }

  private static owners(ownerEoa: Address): Hex[] {
    return [encodeAbiParameters([{ type: "address" }], [ownerEoa])];
  }

  /** Counterfactual address of the wallet for (ownerEoa, salt). */
  async predict(ownerEoa: Address, salt: bigint): Promise<Address> {
    return (await this.cfg.publicClient.readContract({
      address: this.factory,
      abi: FACTORY_ABI,
      functionName: "getAddress",
      args: [CoinbaseSmartWalletClient.owners(ownerEoa), salt],
    })) as Address;
  }

  /** Deploy the wallet (idempotent at the factory level) and return its address. */
  async deploy(ownerKey: Hex, salt: bigint): Promise<Address> {
    const account = privateKeyToAccount(ownerKey);
    const predicted = await this.predict(account.address, salt);
    const wc = createWalletClient({ account, chain: this.cfg.chain, transport: http(this.cfg.rpcUrl) });
    const hash = await wc.writeContract({
      address: this.factory,
      abi: FACTORY_ABI,
      functionName: "createAccount",
      args: [CoinbaseSmartWalletClient.owners(account.address), salt],
    });
    await this.cfg.publicClient.waitForTransactionReceipt({ hash });
    return predicted;
  }

  /** Owner-direct execute: owner EOA calls wallet.execute(target, 0, data). */
  async execute(ownerKey: Hex, wallet: Address, target: Address, data: Hex): Promise<Hex> {
    const account = privateKeyToAccount(ownerKey);
    const wc = createWalletClient({ account, chain: this.cfg.chain, transport: http(this.cfg.rpcUrl) });
    const hash = await wc.writeContract({ address: wallet, abi: WALLET_ABI, functionName: "execute", args: [target, 0n, data] });
    await this.cfg.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  /** Encode the inner call to a target contract (helper for execute / UserOp building). */
  static encodeCall(abi: Abi, functionName: string, args: unknown[]): Hex {
    return encodeFunctionData({ abi, functionName, args });
  }
}
