/**
 * Deterministic in-memory TBA encryption simulation for adversarial tests (no chain needed).
 * Wires InMemoryFinality + InMemoryTBAControl + InMemoryCapabilityOracle + TBAEncKeyStore +
 * TBAKeyService + ResourceKeyManager, and exposes ergonomic helpers for blocks, control transfers,
 * grants/revokes, sealing, and reading.
 */
import { CapType, type Hex } from "@asn/shared";
import {
  ResourceKeyManager,
  TBAKeyService,
  TBAEncKeyStore,
  InMemoryFinality,
  InMemoryCapabilityOracle,
  InMemoryTBAControl,
  makeControlProof,
  generateX25519KeyPair,
  sealRevision,
  readRevision,
  unwrapKey,
  transportAAD,
} from "@asn/encryption";

export function makeTBASim(now: () => number = () => 1000) {
  const finality = new InMemoryFinality();
  const control = new InMemoryTBAControl();
  const oracle = new InMemoryCapabilityOracle(now);
  const encKeys = new TBAEncKeyStore();
  // canonical TBA-of-agent binding (the critical fix): each grantee agentId maps to exactly one TBA.
  const tbaByAgent = new Map<string, Hex>();
  const tbaResolver = async (agentId: bigint): Promise<Hex> => {
    const t = tbaByAgent.get(agentId.toString());
    if (!t) throw new Error(`no canonical TBA bound for agent ${agentId}`);
    return t;
  };
  const service = new TBAKeyService(control, oracle, finality, encKeys, tbaResolver);
  const km = new ResourceKeyManager();

  // canonical chain blocks 0..N; helper to extend + finalize.
  let height = 0n;
  finality.setBlock(0n, ("0x" + "00".repeat(32)) as Hex);
  const mineTo = (n: bigint) => {
    for (let h = height + 1n; h <= n; h++) finality.setBlock(h, blockHash(h));
    height = n > height ? n : height;
  };
  const finalize = (n: bigint) => {
    mineTo(n);
    finality.setFinalized(n);
  };

  /** Register a TBA's enc key (returns pubkey, as the owner would register on-chain). */
  const registerTBA = (tba: Hex) => encKeys.register(tba);

  /** Bind a grantee agentId to its canonical TBA (deterministic ERC-6551 mapping). */
  const bindGrantee = (agentId: bigint, tba: Hex) => tbaByAgent.set(agentId.toString(), tba);

  /** Set the controller secret for a TBA effective from a block (mint or transfer). */
  const setController = (tba: Hex, secret: string, fromBlock: bigint) => control.setController(tba, secret, fromBlock);

  const proofProviderFor = (secret: string) => async (challenge: Hex) => makeControlProof(secret, challenge);

  return {
    finality,
    control,
    oracle,
    encKeys,
    service,
    km,
    mineTo,
    finalize,
    registerTBA,
    bindGrantee,
    setController,
    proofProviderFor,
    grant: (g: bigint, r: Hex, atBlock: bigint, expiry?: number) => oracle.grant(CapType.VIEW, g, r, atBlock, expiry),
    revoke: (g: bigint, r: Hex, atBlock: bigint) => oracle.revoke(CapType.VIEW, g, r, atBlock),
    sealRevision,
    readRevision,
    unwrapKey,
    transportAAD,
    newEphemeral: generateX25519KeyPair,
  };
}

export function blockHash(n: bigint): Hex {
  return ("0x" + n.toString(16).padStart(64, "0")) as Hex;
}

/** A fake TBA address derived from a label (stable, lowercase). */
export function tbaAddr(label: string): Hex {
  const h = label.split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return ("0x" + h.toString(16).padStart(40, "0")) as Hex;
}
