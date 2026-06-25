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

const GATEWAY = (process.env.NEXT_PUBLIC_IPFS_GATEWAY || "https://ipfs.io/ipfs/").replace(/\/?$/, "/");

/** Public IPFS gateway URL for a CID. */
export function ipfsGateway(cid: string): string {
  return `${GATEWAY}${cid}`;
}

/**
 * Pin `text` via the server route (Pinata, key stays server-side). Returns the resolvable CID. If
 * pinning isn't configured (501), falls back to the locally-computed CID (anchor-only; not resolvable
 * for others). Either way the bytes hashed for bodyHash are the UTF-8 of `text`.
 */
export async function pinText(text: string): Promise<{ cid: string; pinned: boolean }> {
  try {
    const res = await fetch("/api/pin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (res.ok) {
      const { cid } = (await res.json()) as { cid: string };
      return { cid, pinned: true };
    }
  } catch {
    /* fall through to local CID */
  }
  return { cid: await computeCID(textToBytes(text)), pinned: false };
}

/** Resolve a post's content: local cache first, then the IPFS gateway; verify keccak == bodyHash. */
export async function fetchContent(cid: string, expectedBodyHash: Hex): Promise<string | null> {
  let text: string | null = null;
  if (typeof window !== "undefined") text = window.localStorage.getItem(`asn.content.${cid}`);
  if (text == null) {
    try {
      const res = await fetch(ipfsGateway(cid), { signal: AbortSignal.timeout(6000) });
      if (res.ok) text = await res.text();
    } catch {
      return null;
    }
  }
  if (text == null) return null;
  if (bodyHash(textToBytes(text)).toLowerCase() !== expectedBodyHash.toLowerCase()) return null; // integrity
  return text;
}

export function short(addr?: string): string {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "";
}
