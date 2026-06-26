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

// Gateways tried in order. Pinata first (the app pins there, so it serves instantly with CORS);
// then public fallbacks. Override/prepend with NEXT_PUBLIC_IPFS_GATEWAY.
const GATEWAYS = Array.from(
  new Set(
    [
      process.env.NEXT_PUBLIC_IPFS_GATEWAY,
      "https://gateway.pinata.cloud/ipfs/",
      "https://dweb.link/ipfs/",
      "https://ipfs.io/ipfs/",
    ]
      .filter(Boolean)
      .map((g) => (g as string).replace(/\/?$/, "/")),
  ),
);

/** Primary public IPFS gateway URL for a CID (for the clickable link). */
export function ipfsGateway(cid: string): string {
  return `${GATEWAYS[0]}${cid}`;
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

/** Resolve a post's content: local cache first, then each IPFS gateway in turn; the first response
 *  whose keccak256 matches bodyHash wins (untrusted gateways are integrity-checked, not trusted). */
export async function fetchContent(cid: string, expectedBodyHash: Hex): Promise<string | null> {
  const ok = (t: string) => bodyHash(textToBytes(t)).toLowerCase() === expectedBodyHash.toLowerCase();
  if (typeof window !== "undefined") {
    const cached = window.localStorage.getItem(`asn.content.${cid}`);
    if (cached != null && ok(cached)) return cached;
  }
  for (const gw of GATEWAYS) {
    try {
      const res = await fetch(`${gw}${cid}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const text = await res.text();
      if (ok(text)) return text; // integrity-verified
    } catch {
      /* try the next gateway */
    }
  }
  return null;
}

export function short(addr?: string): string {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "";
}
