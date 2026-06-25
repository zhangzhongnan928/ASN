/**
 * Real-chain ChainSource: reads Publications `Published`/`Updated` logs via viem. Used by the
 * functional integration tests (M0 discovery) to prove the indexer works against the actual chain.
 * Reorg handling lives in the Indexer (block-hash cursor); this source just exposes canonical data.
 */
import { parseAbiItem, type Abi, type Address, type Hex, type PublicClient } from "viem";
import type { BlockRef, ChainSource, PublicationEvent } from "./types.js";

const PUBLISHED = parseAbiItem(
  "event Published(uint256 indexed agentId, uint256 indexed pubId, string cid, bytes32 cidDigest, bytes32 bodyHash, uint8 visibility, uint32 revision, uint32 keyEpoch, address owner)",
);
const UPDATED = parseAbiItem(
  "event Updated(uint256 indexed agentId, uint256 indexed pubId, string cid, bytes32 cidDigest, bytes32 bodyHash, uint32 revision, uint32 keyEpoch, bool epochRotated)",
);

export class OnchainChainSource implements ChainSource {
  constructor(
    private readonly client: PublicClient,
    private readonly publications: Address,
  ) {}

  async getHead(): Promise<BlockRef> {
    const b = await this.client.getBlock({ blockTag: "latest" });
    return { number: b.number!, hash: b.hash! as Hex, parentHash: b.parentHash as Hex };
  }

  async getBlock(number: bigint): Promise<BlockRef | null> {
    try {
      const b = await this.client.getBlock({ blockNumber: number });
      return { number: b.number!, hash: b.hash! as Hex, parentHash: b.parentHash as Hex };
    } catch {
      return null;
    }
  }

  async getEvents(fromBlock: bigint, toBlock: bigint): Promise<PublicationEvent[]> {
    const [published, updated] = await Promise.all([
      this.client.getLogs({ address: this.publications, event: PUBLISHED, fromBlock, toBlock }),
      this.client.getLogs({ address: this.publications, event: UPDATED, fromBlock, toBlock }),
    ]);
    const out: PublicationEvent[] = [];
    for (const l of published) {
      const a = l.args as Record<string, unknown>;
      out.push({
        kind: "Published",
        blockNumber: l.blockNumber!,
        blockHash: l.blockHash! as Hex,
        logIndex: l.logIndex!,
        agentId: a.agentId as bigint,
        pubId: a.pubId as bigint,
        cid: a.cid as string,
        cidDigest: a.cidDigest as Hex,
        bodyHash: a.bodyHash as Hex,
        revision: Number(a.revision),
        keyEpoch: Number(a.keyEpoch),
        visibility: Number(a.visibility),
        owner: a.owner as Hex,
      });
    }
    for (const l of updated) {
      const a = l.args as Record<string, unknown>;
      out.push({
        kind: "Updated",
        blockNumber: l.blockNumber!,
        blockHash: l.blockHash! as Hex,
        logIndex: l.logIndex!,
        agentId: a.agentId as bigint,
        pubId: a.pubId as bigint,
        cid: a.cid as string,
        cidDigest: a.cidDigest as Hex,
        bodyHash: a.bodyHash as Hex,
        revision: Number(a.revision),
        keyEpoch: Number(a.keyEpoch),
        visibility: 1, // updates only apply to existing pubs; visibility carried from Published in fold
        owner: ("0x" + "00".repeat(20)) as Hex, // ignored by fold for Updated (prev.owner kept)
      });
    }
    return out;
  }
}
