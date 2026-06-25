/**
 * Viem-backed ChainBackend for the MCP server (spec §10). Wires the owner-authorized MCP write tools
 * to real on-chain calls via the agent's Coinbase Smart Wallet. The MCP layer guarantees these are
 * only reached with a valid owner authorization (untrusted content can never get here).
 */
import type { Abi, Address, Hex, PublicClient } from "viem";
import type { ChainBackend, PublishParams, GrantParams, RevokeParams } from "@asn/mcp";
import { CoinbaseSmartWalletClient } from "./wallet.js";

export interface BackendConfig {
  wallet: CoinbaseSmartWalletClient;
  ownerKey: Hex;
  walletAddress: Address;
  publicClient: PublicClient;
  addr: { agentID: Address; capabilityToken: Address; publications: Address };
  abis: { AgentID: Abi; CapabilityToken: Abi; Publications: Abi };
}

export class ViemChainBackend implements ChainBackend {
  constructor(private readonly cfg: BackendConfig) {}

  private exec(target: Address, abi: Abi, fn: string, args: unknown[]): Promise<Hex> {
    return this.cfg.wallet.execute(this.cfg.ownerKey, this.cfg.walletAddress, target, CoinbaseSmartWalletClient.encodeCall(abi, fn, args));
  }

  async register(_smartAccount: Address): Promise<{ agentId: bigint }> {
    // self-mint: the agent's smart account mints its own identity (P1-B anti-grief). _smartAccount is
    // the configured wallet (== msg.sender), so the NFT lands on it.
    await this.exec(this.cfg.addr.agentID, this.cfg.abis.AgentID, "mint", []);
    const id = (await this.cfg.publicClient.readContract({
      address: this.cfg.addr.agentID,
      abi: this.cfg.abis.AgentID,
      functionName: "totalMinted",
    })) as bigint;
    return { agentId: id };
  }

  async publish(p: PublishParams): Promise<{ pubId: bigint }> {
    await this.exec(this.cfg.addr.publications, this.cfg.abis.Publications, "publish", [p.agentId, p.cid, p.bodyHash, p.visibility]);
    const count = (await this.cfg.publicClient.readContract({
      address: this.cfg.addr.publications,
      abi: this.cfg.abis.Publications,
      functionName: "pubCount",
      args: [p.agentId],
    })) as bigint;
    return { pubId: count };
  }

  async grantCapability(p: GrantParams): Promise<void> {
    await this.exec(this.cfg.addr.capabilityToken, this.cfg.abis.CapabilityToken, "grant", [p.capType, p.granteeAgentId, p.resourceId, p.expiry]);
  }

  async revokeCapability(p: RevokeParams): Promise<void> {
    await this.exec(this.cfg.addr.capabilityToken, this.cfg.abis.CapabilityToken, "revoke", [p.capType, p.granteeAgentId, p.resourceId]);
  }
}
