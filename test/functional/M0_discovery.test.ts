/**
 * M0 exit criterion (spec §12.1): "A 不注册任何 Web2 账号即可创建身份并发帖;B 通过独立 feed API 发现".
 * A (only a smart account) permissionlessly mints an identity and publishes; B discovers it purely
 * through the independent feed API reading real on-chain logs. No Web2 account anywhere in the flow.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { utf8 } from "@asn/shared";
import { computeCID, bodyHash as hashBody } from "@asn/encryption";
import { Indexer, FeedApi, OnchainChainSource, InMemoryContentStore } from "@asn/indexer";
import { startChain, type ChainHarness } from "../helpers/chain.js";

describe("M0 — agent-native publishing & discovery", () => {
  let chain: ChainHarness;
  beforeAll(async () => {
    chain = await startChain();
  }, 60_000);
  afterAll(async () => {
    await chain?.stop();
  });

  it("A mints an identity and publishes with no Web2 account; B discovers via the feed API", async () => {
    const keyA = chain.keys[1]!;
    const walletA: Address = await chain.createWallet(keyA, 0n);

    // A mints its identity (permissionless self-mint, one call) through its own smart account.
    await chain.execute(
      keyA,
      walletA,
      chain.addr.agentID,
      encodeFunctionData({ abi: chain.abis.AgentID, functionName: "mint", args: [] }),
    );
    const agentId = (await chain.publicClient.readContract({
      address: chain.addr.agentID,
      abi: chain.abis.AgentID,
      functionName: "totalMinted",
    })) as bigint;
    expect(agentId).toBe(1n);
    // the identity is owned by the smart account (no Web2 account involved).
    const owner = (await chain.publicClient.readContract({
      address: chain.addr.agentID,
      abi: chain.abis.AgentID,
      functionName: "ownerOf",
      args: [agentId],
    })) as Address;
    expect(owner.toLowerCase()).toBe(walletA.toLowerCase());

    // A publishes a public post. Content lives off-chain (content store), anchored on-chain.
    const body = utf8("hello from an agent, no signup required");
    const cid = await computeCID(body);
    const content = new InMemoryContentStore();
    content.put(cid, body);
    await chain.execute(
      keyA,
      walletA,
      chain.addr.publications,
      encodeFunctionData({
        abi: chain.abis.Publications,
        functionName: "publish",
        args: [agentId, cid, hashBody(body), 0],
      }),
    );

    // B discovers via the INDEPENDENT feed API (indexer over real chain logs).
    const indexer = new Indexer(new OnchainChainSource(chain.publicClient, chain.addr.publications), content);
    await indexer.sync();
    const feed = new FeedApi(indexer);
    const page = feed.getFeed({ limit: 10 });

    expect(page.items.length).toBe(1);
    const item = page.items[0]!;
    expect(item.agentId).toBe(agentId);
    expect(item.cid).toBe(cid);
    expect(item.visibility).toBe(0);
    expect(item.owner.toLowerCase()).toBe(walletA.toLowerCase());

    // and the content is fetchable + integrity-verified (indexer only admits verified CIDs).
    const fetched = await content.get(item.cid);
    expect(fetched).not.toBeNull();
    expect(hashBody(fetched!)).toBe(item.bodyHash);
    void (null as unknown as Hex);
  });
});
