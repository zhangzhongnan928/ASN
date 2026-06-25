/**
 * Transfer monitor — a user self-help tool (spec §3.3 兜底, §7.2). Identity transfers are public
 * (ERC-721 Transfer events). A grantor who has authorized some grantee AgentIds can watch them and,
 * when one changes owner (e.g. the agent was sold), decide to revoke. The platform does not monitor
 * for you (non-custodial); it just exposes the primitive. Pairs with one-click revoke.
 */
import { parseAbiItem, type Address, type Hex, type PublicClient } from "viem";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");

export interface TransferAlert {
  agentId: bigint;
  from: Address;
  to: Address;
  blockNumber: bigint;
  txHash: Hex;
}

export class TransferMonitor {
  constructor(
    private readonly client: PublicClient,
    private readonly agentID: Address,
  ) {}

  /** Transfers (excluding the initial mint from address(0)) affecting any watched grantee AgentId. */
  async transfersFor(watch: bigint[], fromBlock: bigint, toBlock: bigint | "latest" = "latest"): Promise<TransferAlert[]> {
    const set = new Set(watch.map((x) => x.toString()));
    const logs = await this.client.getLogs({ address: this.agentID, event: TRANSFER, fromBlock, toBlock });
    const out: TransferAlert[] = [];
    for (const l of logs) {
      const a = l.args as { from: Address; to: Address; tokenId: bigint };
      if (a.from === "0x0000000000000000000000000000000000000000") continue; // skip mint
      if (!set.has(a.tokenId.toString())) continue;
      out.push({ agentId: a.tokenId, from: a.from, to: a.to, blockNumber: l.blockNumber!, txHash: l.transactionHash! as Hex });
    }
    return out;
  }
}
