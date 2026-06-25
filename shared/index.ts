/**
 * Shared primitives for ASN off-chain services.
 */
import { keccak256 as viemKeccak, toHex, hexToBytes, bytesToHex, encodeAbiParameters } from "viem";

export type Hex = `0x${string}`;

/** Capability types — mirrors the on-chain enum (MVP: VIEW only). */
export enum CapType {
  VIEW = 0,
  DM = 1,
  GROUP_CREATE = 2,
  DATA_ACCESS = 3,
}

export const keccak256 = (bytes: Uint8Array): Hex => viemKeccak(bytes);

export { toHex, hexToBytes, bytesToHex };

/** Canonical resourceId = keccak256(abi.encode(uint256 agentId, uint256 pubId)) — matches Publications.resourceIdOf. */
export function resourceId(agentId: bigint, pubId: bigint): Hex {
  return viemKeccak(
    hexToBytes(
      encodeAbiParameters(
        [
          { type: "uint256", name: "agentId" },
          { type: "uint256", name: "pubId" },
        ],
        [agentId, pubId],
      ),
    ),
  );
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function fromUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
