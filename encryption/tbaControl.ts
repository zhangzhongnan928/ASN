/**
 * TBA control verification (spec v0.3 R2). The core invariant of the whole encryption-inheritance
 * model: KEY = CONTROL OF THE TBA = CURRENT NFT OWNERSHIP. The key service releases a CEK only to a
 * party that proves it currently controls the grantee's Token Bound Account, via ERC-1271
 * (`ASNTokenBoundAccount.isValidSignature`, which delegates to the current owner). Because the TBA
 * address is fixed by the NFT and control follows ownership, transferring the NFT automatically hands
 * the new owner the ability to prove control — no re-seal, no seller cooperation.
 */
import { keccak256, concatBytes, utf8, hexToBytes, type Hex } from "@asn/shared";

export const ERC1271_MAGIC: Hex = "0x1626ba7e";

export interface TBAControlVerifier {
  /** Does `proof` prove control of `tba` over `challenge`, evaluated at finalized block `atBlock`? */
  verifyControl(tba: Hex, challenge: Hex, proof: Hex, atBlock: bigint): Promise<boolean>;
}

/**
 * Deterministic, block-aware control model for tests. Control of a TBA is represented by a secret;
 * `makeControlProof(secret, challenge)` is the "signature". A transfer at block H changes the secret
 * as of H. Crucially, control is resolved AS OF a block, so a transfer that only exists in an
 * unsafe/orphaned block does NOT change the controller at the finalized block (P0-A).
 */
export class InMemoryTBAControl implements TBAControlVerifier {
  /** tba -> ordered list of {fromBlock, secret} controller changes. */
  private timeline = new Map<Hex, Array<{ fromBlock: bigint; secret: string }>>();

  /** Set the controller secret effective from `fromBlock` (e.g. mint, or a transfer). */
  setController(tba: Hex, secret: string, fromBlock: bigint): this {
    const arr = this.timeline.get(tba) ?? [];
    arr.push({ fromBlock, secret });
    arr.sort((a, b) => (a.fromBlock < b.fromBlock ? -1 : a.fromBlock > b.fromBlock ? 1 : 0));
    this.timeline.set(tba, arr);
    return this;
  }

  /** Reorg: drop controller changes at or above `fromHeight` (orphaned). */
  reorgFrom(fromHeight: bigint): void {
    for (const [tba, arr] of this.timeline) this.timeline.set(tba, arr.filter((c) => c.fromBlock < fromHeight));
  }

  /** The controller secret in effect at `atBlock` (latest change with fromBlock <= atBlock). */
  private secretAt(tba: Hex, atBlock: bigint): string | null {
    const arr = this.timeline.get(tba);
    if (!arr) return null;
    let secret: string | null = null;
    for (const c of arr) if (c.fromBlock <= atBlock) secret = c.secret;
    return secret;
  }

  async verifyControl(tba: Hex, challenge: Hex, proof: Hex, atBlock: bigint): Promise<boolean> {
    const secret = this.secretAt(tba, atBlock);
    if (secret === null) return false;
    return proof === makeControlProof(secret, challenge);
  }
}

/** Deterministic proof the InMemory model accepts: keccak(secret || challenge). */
export function makeControlProof(secret: string, challenge: Hex): Hex {
  return keccak256(concatBytes(utf8(secret), hexToBytes(challenge)));
}

/** Reads the real on-chain TBA ERC-1271 at a specific (finalized) block via viem. */
export class OnchainTBAControl implements TBAControlVerifier {
  constructor(
    private readonly client: {
      readContract(args: {
        address: Hex;
        abi: readonly unknown[];
        functionName: string;
        args: readonly unknown[];
        blockNumber?: bigint;
      }): Promise<unknown>;
    },
    private readonly tbaAbi: readonly unknown[],
  ) {}

  async verifyControl(tba: Hex, challenge: Hex, proof: Hex, atBlock: bigint): Promise<boolean> {
    try {
      const res = (await this.client.readContract({
        address: tba,
        abi: this.tbaAbi,
        functionName: "isValidSignature",
        args: [challenge, proof],
        blockNumber: atBlock,
      })) as Hex;
      return res?.toLowerCase() === ERC1271_MAGIC;
    } catch {
      return false;
    }
  }
}

/** Challenge binds a key request to (resource, epoch, grantee AGENT-ID + its TBA, requester transport
 *  key, block). Including the agentId stops a control proof from being re-paired with a different
 *  grantee identity. */
export function controlChallenge(
  resourceId: Hex,
  epoch: number,
  granteeAgentId: bigint,
  granteeTBA: Hex,
  requesterEphemeralPublicKeyHex: Hex,
  authBlockHash: Hex,
): Hex {
  return keccak256(
    utf8(`asn/control/${resourceId}/${epoch}/${granteeAgentId}/${granteeTBA}/${requesterEphemeralPublicKeyHex}/${authBlockHash}`),
  );
}
