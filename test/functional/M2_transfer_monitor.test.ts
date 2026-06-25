/**
 * M2 exit (spec §12.1): "grantor 能看到 grantee transfer 并成功 revoke."
 * A authorizes B; B sells its identity (transfers the AgentID NFT) to a stranger; A's transfer
 * monitor detects the ownership change from the public Transfer event, and A revokes — the granted
 * capability is cut off. The platform monitors nothing for A; it just exposes the primitive (§3.3).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { resourceId as makeResourceId } from "@asn/shared";
import { TransferMonitor } from "@asn/labeler";
import { startChain, type ChainHarness } from "../helpers/chain.js";

describe("M2 — transfer monitor + one-click revoke", () => {
  let chain: ChainHarness;
  beforeAll(async () => {
    chain = await startChain();
  }, 60_000);
  afterAll(async () => {
    await chain?.stop();
  });

  it("grantor detects a grantee identity transfer and revokes the capability", async () => {
    const [, kA, kB, kStranger] = chain.keys as [Hex, Hex, Hex, Hex];
    const wA = await chain.createWallet(kA, 20n);
    const wB = await chain.createWallet(kB, 21n);
    const wStranger = await chain.createWallet(kStranger, 22n);

    const mint = async (key: Hex, w: Address) => {
      await chain.execute(key, w, chain.addr.agentID, encodeFunctionData({ abi: chain.abis.AgentID, functionName: "mint", args: [] }));
      return (await chain.publicClient.readContract({ address: chain.addr.agentID, abi: chain.abis.AgentID, functionName: "totalMinted" })) as bigint;
    };
    const agentA = await mint(kA, wA);
    const agentB = await mint(kB, wB);

    // A publishes a gated pub and grants B.
    const rid = makeResourceId(agentA, 1n);
    await chain.execute(kA, wA, chain.addr.publications, encodeFunctionData({ abi: chain.abis.Publications, functionName: "publish", args: [agentA, "cidGated", ("0x" + "aa".repeat(32)) as Hex, 1] }));
    await chain.execute(kA, wA, chain.addr.capabilityToken, encodeFunctionData({ abi: chain.abis.CapabilityToken, functionName: "grant", args: [0, agentB, rid, 0] }));

    // current-state capability check (read at latest).
    const hasCap = async (): Promise<boolean> =>
      (await chain.publicClient.readContract({
        address: chain.addr.capabilityToken,
        abi: chain.abis.CapabilityToken,
        functionName: "hasCapability",
        args: [0, agentB, rid],
      })) as boolean;
    expect(await hasCap()).toBe(true);

    // B SELLS its identity: transfers agentB to a stranger.
    await chain.execute(kB, wB, chain.addr.agentID, encodeFunctionData({ abi: chain.abis.AgentID, functionName: "transferFrom", args: [wB, wStranger, agentB] }));

    // A's transfer monitor (watching agentB) detects the ownership change.
    const monitor = new TransferMonitor(chain.publicClient as never, chain.addr.agentID);
    const alerts = await monitor.transfersFor([agentB], 0n, "latest");
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.agentId).toBe(agentB);
    expect(alerts[0]!.to.toLowerCase()).toBe(wStranger.toLowerCase());

    // The capability still follows the identity to the stranger (full inheritance) — which is exactly
    // why A must monitor + revoke.
    expect(await hasCap()).toBe(true);

    // A revokes (one click). Capability cut off.
    await chain.execute(kA, wA, chain.addr.capabilityToken, encodeFunctionData({ abi: chain.abis.CapabilityToken, functionName: "revoke", args: [0, agentB, rid] }));
    expect(await hasCap()).toBe(false);
  });
});
