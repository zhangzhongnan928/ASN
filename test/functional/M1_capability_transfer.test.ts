/**
 * M1 + R2 on-chain integration: ERC-6551 TBA decryption inheritance wired to the REAL contracts.
 *
 * Proves the full-inheritance encryption claim end-to-end on a real chain:
 *  - A grants B; the CEK is sealed to B's TBA; B reads by proving control via real ERC-1271.
 *  - C (no capability) cannot read even controlling its own TBA.
 *  - B SELLS its identity (transfers the AgentID NFT); the new owner controls the SAME TBA and reads
 *    the SAME pre-sale envelope — no cooperation from B or A. The old owner can no longer prove control.
 *  - revoke + rotate: the revoked party cannot read the rotated revision.
 *
 * Control is verified against the real ASNTokenBoundAccount.isValidSignature (which delegates to the
 * Coinbase Smart Wallet owner), and capability against the real CapabilityToken.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { CapType, utf8, fromUtf8, resourceId as makeResourceId } from "@asn/shared";
import {
  ResourceKeyManager,
  TBAKeyService,
  TBAEncKeyStore,
  OnchainCapabilityOracle,
  OnchainTBAControl,
  OnchainFinality,
  sealRevision,
  readRevision,
  generateX25519KeyPair,
} from "@asn/encryption";
import { startChain, type ChainHarness } from "../helpers/chain.js";

describe("M1/R2 — TBA decryption inheritance on a real chain", () => {
  let chain: ChainHarness;
  beforeAll(async () => {
    chain = await startChain();
  }, 60_000);
  afterAll(async () => {
    await chain?.stop();
  });

  const selfMint = async (key: Hex, w: Address): Promise<bigint> => {
    await chain.execute(key, w, chain.addr.agentID, encodeFunctionData({ abi: chain.abis.AgentID, functionName: "mint", args: [] }));
    return (await chain.publicClient.readContract({ address: chain.addr.agentID, abi: chain.abis.AgentID, functionName: "totalMinted" })) as bigint;
  };

  it("grant→read; C denied; transfer→new owner inherits; revoke+rotate cuts off", async () => {
    const [, kA, kB, kC, kNew] = chain.keys as [Hex, Hex, Hex, Hex, Hex];
    const wA = await chain.createWallet(kA, 30n);
    const wB = await chain.createWallet(kB, 31n);
    const wC = await chain.createWallet(kC, 32n);
    const wNew = await chain.createWallet(kNew, 33n);

    const agentA = await selfMint(kA, wA);
    const agentB = await selfMint(kB, wB);
    const agentC = await selfMint(kC, wC);

    // Create TBAs (encryption identities) for B and C.
    const tbaB = await chain.createTBA(agentB);
    const tbaC = await chain.createTBA(agentC);

    // The key service custodies the TBA enc keypairs; owners register the PUBLIC keys on-chain.
    const encKeys = new TBAEncKeyStore();
    const pubB = encKeys.register(tbaB);
    const pubC = encKeys.register(tbaC);
    await chain.execute(kB, wB, chain.addr.tbaKeyRegistry, encodeFunctionData({ abi: chain.abis.TBAKeyRegistry, functionName: "registerKey", args: [tbaB, ("0x" + Buffer.from(pubB).toString("hex")) as Hex] }));
    await chain.execute(kC, wC, chain.addr.tbaKeyRegistry, encodeFunctionData({ abi: chain.abis.TBAKeyRegistry, functionName: "registerKey", args: [tbaC, ("0x" + Buffer.from(pubC).toString("hex")) as Hex] }));

    // A publishes a gated resource and grants B.
    const rid = makeResourceId(agentA, 1n);
    const km = new ResourceKeyManager();
    km.createResource(rid);
    const rev1 = await sealRevision(km, rid, utf8("A's private revision 1"));
    await chain.execute(kA, wA, chain.addr.publications, encodeFunctionData({ abi: chain.abis.Publications, functionName: "publish", args: [agentA, rev1.cid, rev1.bodyHash, 1] }));
    await chain.execute(kA, wA, chain.addr.capabilityToken, encodeFunctionData({ abi: chain.abis.CapabilityToken, functionName: "grant", args: [0, agentB, rid, 0] }));

    // Seal the epoch-0 CEK to B's canonical TBA (the at-rest envelope). The key service derives the
    // TBA from the granteeAgentId via the ERC-6551 registry — binding capability to control.
    const control = new OnchainTBAControl(chain.publicClient as never, chain.abis.ASNTokenBoundAccount);
    const oracle = new OnchainCapabilityOracle(chain.publicClient as never, chain.addr.capabilityToken, chain.abis.CapabilityToken);
    const finality = new OnchainFinality(chain.publicClient as never, "latest"); // anvil has no real finality
    const tbaResolver = (agentId: bigint) => chain.tbaAddress(agentId);
    const service = new TBAKeyService(control, oracle, finality, encKeys, tbaResolver);
    await service.sealFor(rid, 0, km.cek(rid, 0), agentB);

    // B reads by proving control of its canonical TBA via real ERC-1271 (signed by B's wallet owner).
    const read = async (ownerKey: Hex, ownerWallet: Address, agentId: bigint, body: Uint8Array) =>
      readRevision(
        service,
        { resourceId: rid, epoch: 0, granteeAgentId: agentId, proofProvider: (c: Hex) => chain.erc1271Proof(ownerKey, ownerWallet, c), ephemeral: generateX25519KeyPair() },
        body,
      );

    // B (granted, controls tbaB) reads.
    expect(fromUtf8((await read(kB, wB, agentB, rev1.body))!)).toBe("A's private revision 1");

    // C (controls tbaC but has NO capability) is denied.
    expect(await read(kC, wC, agentC, rev1.body)).toBeNull();
    void tbaC;

    // ── B SELLS its identity to a new owner (transfers agentB). TBA address unchanged.
    await chain.execute(kB, wB, chain.addr.agentID, encodeFunctionData({ abi: chain.abis.AgentID, functionName: "transferFrom", args: [wB, wNew, agentB] }));
    expect(((await chain.publicClient.readContract({ address: chain.addr.agentID, abi: chain.abis.AgentID, functionName: "ownerOf", args: [agentB] })) as Address).toLowerCase()).toBe(wNew.toLowerCase());

    // New owner controls tbaB → reads the SAME pre-sale envelope (no seller/publisher cooperation).
    expect(fromUtf8((await read(kNew, wNew, agentB, rev1.body))!)).toBe("A's private revision 1");
    // Old owner (B) can no longer prove control → denied.
    expect(await read(kB, wB, agentB, rev1.body)).toBeNull();

    // ── revoke + rotate: the (now new-owner-held) capability is revoked; rotated revision unreadable.
    await chain.execute(kA, wA, chain.addr.capabilityToken, encodeFunctionData({ abi: chain.abis.CapabilityToken, functionName: "revoke", args: [0, agentB, rid] }));
    km.rotate(rid);
    const rev2 = await sealRevision(km, rid, utf8("A's private revision 2"));
    await service.sealFor(rid, 1, km.cek(rid, 1), agentB); // even if sealed, capability gate blocks it
    const newOwnerRead2 = await readRevision(
      service,
      { resourceId: rid, epoch: 1, granteeAgentId: agentB, proofProvider: (c: Hex) => chain.erc1271Proof(kNew, wNew, c), ephemeral: generateX25519KeyPair() },
      rev2.body,
    );
    expect(newOwnerRead2).toBeNull(); // revoked → no key for the new epoch
    void CapType;
  });
});
