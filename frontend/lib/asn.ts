import { keccak256, encodeAbiParameters, stringToBytes, type Hex } from "viem";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";

/** Canonical resourceId = keccak256(abi.encode(uint256 agentId, uint256 pubId)) — matches Publications. */
export function resourceId(agentId: bigint, pubId: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256", name: "agentId" },
        { type: "uint256", name: "pubId" },
      ],
      [agentId, pubId],
    ),
  );
}

/** CIDv1 (raw, sha2-256) of bytes — matches the indexer's content addressing. */
export async function computeCID(bytes: Uint8Array): Promise<string> {
  const digest = await sha256.digest(bytes);
  return CID.create(1, raw.code, digest).toString();
}

/** keccak256 of the stored body bytes — matches Publications.bodyHash. */
export function bodyHash(bytes: Uint8Array): Hex {
  return keccak256(bytes);
}

export function textToBytes(s: string): Uint8Array {
  return stringToBytes(s);
}

/** Public IPFS gateway URL for a CID (content must be pinned elsewhere to resolve). */
export function ipfsGateway(cid: string): string {
  return `https://ipfs.io/ipfs/${cid}`;
}

export function short(addr?: string): string {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "";
}
